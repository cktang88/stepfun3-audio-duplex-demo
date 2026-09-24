const RATE = 24000;
const $ = (selector) => document.querySelector(selector);
const button = $("#start-button");
const statusLed = $("#status-led");
const statusLabel = $("#status-label");
const stage = $("#visual-stage");
const stageCaption = $("#stage-caption");
const stageHint = $("#stage-hint");
const conversation = $("#conversation");
const settingsToggle = $("#settings-toggle");
const settingsPanel = $("#settings-panel");
const modelSelect = $("#model-select");
const voiceSelect = $("#voice-select");
const replyLanguageInput = $("#reply-language");
const instructionsInput = $("#instructions");
const prefixPaddingInput = $("#prefix-padding");
const silenceDurationInput = $("#silence-duration");
const energyThresholdInput = $("#energy-threshold");
const echoCancellationInput = $("#echo-cancellation");
const noiseSuppressionInput = $("#noise-suppression");
const autoGainControlInput = $("#auto-gain-control");
const connectionOptions = [modelSelect, echoCancellationInput, noiseSuppressionInput, autoGainControlInput];
const outputVolumeInput = $("#output-volume");
const outputVolumeValue = $("#output-volume-value");
let socket, context, stream, processor, source, silentGain, outputGain;
let nextPlaybackTime = 0;
let activeSources = new Set();
let currentAssistantMessage;
let stoppedByUser = false;
let showedError = false;
let sessionConfigured = false;

settingsToggle.addEventListener("click", () => {
  const expanded = settingsToggle.getAttribute("aria-expanded") === "true";
  settingsToggle.setAttribute("aria-expanded", String(!expanded));
  settingsPanel.hidden = expanded;
});
button.addEventListener("click", () => socket || stream ? stopConversation() : startConversation());
replyLanguageInput.addEventListener("change", applyInstructions);
instructionsInput.addEventListener("change", applyInstructions);
outputVolumeInput.addEventListener("input", applyPlaybackVolume);
for (const input of [prefixPaddingInput, silenceDurationInput, energyThresholdInput]) {
  input.addEventListener("change", applyVadSettings);
}

async function startConversation() {
  stoppedByUser = false;
  showedError = false;
  sessionConfigured = false;
  button.disabled = true;
  updateStatus("Connecting…", "busy", "Setting up your audio session", "Please allow microphone access if asked", "");
  try {
    setConnectionOptionsDisabled(true);
    stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1,
      echoCancellation: echoCancellationInput.checked,
      noiseSuppression: noiseSuppressionInput.checked,
      autoGainControl: autoGainControlInput.checked,
    } });
    context = new AudioContext({ sampleRate: RATE });
    await context.resume();
    outputGain = context.createGain();
    outputGain.connect(context.destination);
    applyPlaybackVolume();
    socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/realtime?model=${encodeURIComponent(modelSelect.value)}`);
    socket.addEventListener("open", () => updateStatus("Connected · configuring voice", "busy", "Almost there", "Preparing live audio", ""));
    socket.addEventListener("message", handleServerMessage);
    socket.addEventListener("error", () => showError("The realtime connection failed. Check that the local server is running."));
    socket.addEventListener("close", () => {
      if (!stoppedByUser && !showedError) showError("The connection closed. Start a new conversation to try again.");
      cleanupAudio();
      socket = undefined;
    });
  } catch (error) {
    showError(error.name === "NotAllowedError" ? "Microphone permission was blocked. Allow access in your browser settings, then try again." : `Could not start audio: ${error.message}`);
    cleanupAudio();
    socket = undefined;
  }
}

function handleServerMessage(message) {
  let event;
  try { event = JSON.parse(message.data); } catch { return; }
  if (event.type === "proxy.error") {
    showError(event.message);
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    return;
  }
  switch (event.type) {
    case "session.created": {
      const session = getSessionSettings();
      if (!session) {
        showAdvancedSettingsError();
        socket.close(1000, "Invalid advanced audio settings");
        break;
      }
      sessionConfigured = true;
      voiceSelect.disabled = true;
      send({ type: "session.update", session });
      break;
    }
    case "session.updated":
      if (!processor) startMicrophoneStream();
      break;
    case "input_audio_buffer.speech_started":
      stopScheduledPlayback();
      updateStatus("Listening · you can interrupt anytime", "active", "I’m listening", "Keep talking, even while I reply", "listening");
      break;
    case "input_audio_buffer.speech_stopped": updateStatus("Thinking…", "busy", "One moment", "I’m putting a response together", ""); break;
    case "conversation.item.input_audio_transcription.completed": addMessage("user", event.transcript); break;
    case "response.audio_transcript.delta":
    case "response.text.delta":
      appendAssistantText(event.delta ?? "");
      updateStatus("Speaking · still listening", "active", "Here’s what I think", "Jump in whenever you like", "speaking");
      break;
    case "response.audio.delta":
      playPcm16(event.delta);
      updateStatus("Speaking · still listening", "active", "Here’s what I think", "Jump in whenever you like", "speaking");
      break;
    case "response.audio_transcript.done":
      if (event.transcript && currentAssistantMessage) setMessageText(currentAssistantMessage, event.transcript);
      break;
    case "response.done":
      currentAssistantMessage = undefined;
      updateStatus("Listening · you can interrupt anytime", "active", "I’m listening", "Keep talking, even while I reply", "listening");
      break;
    case "error": showError(event.error?.message ?? "StepFun returned an error."); break;
  }
}

function startMicrophoneStream() {
  if (!stream || !context || !socket || socket.readyState !== WebSocket.OPEN) return;
  source = context.createMediaStreamSource(stream);
  processor = context.createScriptProcessor(2048, 1, 1);
  silentGain = context.createGain();
  silentGain.gain.value = 0;
  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(context.destination);
  processor.onaudioprocess = (event) => {
    if (socket?.readyState === WebSocket.OPEN) send({ type: "input_audio_buffer.append", audio: resampleAndEncode(event.inputBuffer.getChannelData(0), context.sampleRate) });
  };
  voiceSelect.disabled = true;
  button.disabled = false;
  button.classList.add("stop");
  $("#button-label").textContent = "End conversation";
  updateStatus("Listening · you can interrupt anytime", "active", "I’m listening", "Keep talking, even while I reply", "listening");
}

function resampleAndEncode(input, inputRate) {
  const outputLength = Math.floor(input.length * RATE / inputRate);
  const pcm = new Int16Array(outputLength);
  const ratio = inputRate / RATE;
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const fraction = position - left;
    const sample = input[left] * (1 - fraction) + input[Math.min(left + 1, input.length - 1)] * fraction;
    pcm[i] = Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767);
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  return btoa(binary);
}

function playPcm16(base64) {
  if (!context || !base64) return;
  const binary = atob(base64);
  const count = Math.floor(binary.length / 2);
  const audio = context.createBuffer(1, count, RATE);
  const samples = audio.getChannelData(0);
  for (let i = 0; i < count; i += 1) {
    const value = (binary.charCodeAt(i * 2) & 255) | ((binary.charCodeAt(i * 2 + 1) & 255) << 8);
    samples[i] = (value & 0x8000 ? value - 0x10000 : value) / 32768;
  }
  const player = context.createBufferSource();
  player.buffer = audio;
  player.connect(outputGain);
  const startAt = Math.max(context.currentTime + 0.025, nextPlaybackTime);
  player.start(startAt);
  nextPlaybackTime = startAt + audio.duration;
  activeSources.add(player);
  player.addEventListener("ended", () => activeSources.delete(player), { once: true });
}

function stopScheduledPlayback() {
  for (const player of activeSources) try { player.stop(); } catch { /* Already stopped. */ }
  activeSources.clear();
  nextPlaybackTime = context?.currentTime ?? 0;
}
function getSessionSettings() {
  const turnDetection = getTurnDetection();
  if (!turnDetection) return null;
  return {
    modalities: ["text", "audio"],
    instructions: getInstructions(),
    voice: voiceSelect.value,
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
    turn_detection: turnDetection,
  };
}
function getInstructions() {
  const style = instructionsInput.value.trim();
  const language = replyLanguageInput.value;
  if (language === "auto") return style;
  return `Respond in ${language} by default. If the user asks for another language, follow that request.\n\n${style}`;
}
function applyInstructions() {
  if (sessionConfigured) send({ type: "session.update", session: { instructions: getInstructions() } });
}
function applyPlaybackVolume() {
  const value = outputVolumeInput.valueAsNumber;
  outputVolumeValue.value = `${value}%`;
  if (outputGain && context) outputGain.gain.setTargetAtTime(value / 100, context.currentTime, 0.015);
}
function setConnectionOptionsDisabled(disabled) {
  for (const input of connectionOptions) input.disabled = disabled;
}
function getTurnDetection() {
  const prefixPadding = readNonnegativeInteger(prefixPaddingInput);
  const silenceDuration = readNonnegativeInteger(silenceDurationInput);
  const energyThreshold = readNonnegativeInteger(energyThresholdInput, 5000);
  if (prefixPadding === null || silenceDuration === null || energyThreshold === null) return null;
  return {
    type: "server_vad",
    prefix_padding_ms: prefixPadding,
    silence_duration_ms: silenceDuration,
    energy_awakeness_threshold: energyThreshold,
  };
}
function readNonnegativeInteger(input, maximum = Infinity) {
  const value = input.valueAsNumber;
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    input.setCustomValidity(`Enter a whole number from 0 to ${maximum === Infinity ? "the supported limit" : maximum}.`);
    return null;
  }
  input.setCustomValidity("");
  return value;
}
function applyVadSettings() {
  const turnDetection = getTurnDetection();
  if (turnDetection && sessionConfigured) {
    send({ type: "session.update", session: { turn_detection: turnDetection } });
  } else if (!turnDetection) {
    [prefixPaddingInput, silenceDurationInput, energyThresholdInput].find((input) => !input.checkValidity())?.reportValidity();
  }
}
function showAdvancedSettingsError() {
  settingsPanel.hidden = false;
  settingsToggle.setAttribute("aria-expanded", "true");
  const advanced = document.querySelector(".advanced-settings");
  advanced.open = true;
  [prefixPaddingInput, silenceDurationInput, energyThresholdInput].find((input) => !input.checkValidity())?.reportValidity();
  showError("Check the advanced audio values, then start again.");
}
function appendAssistantText(text) {
  if (!text) return;
  if (!currentAssistantMessage) currentAssistantMessage = createMessage("assistant");
  const node = currentAssistantMessage.querySelector(".message-text");
  node.textContent += text;
  conversation.scrollTop = conversation.scrollHeight;
}
function addMessage(role, text) {
  if (!text) return;
  const message = createMessage(role);
  setMessageText(message, text);
  conversation.scrollTop = conversation.scrollHeight;
}
function createMessage(role) {
  const message = document.createElement("article");
  message.className = `message ${role}`;
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "user" ? "You" : "StepAudio";
  const text = document.createElement("div");
  text.className = "message-text";
  message.append(label, text);
  conversation.append(message);
  return message;
}
function setMessageText(message, text) { message.querySelector(".message-text").textContent = text; }
function send(event) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); }
function updateStatus(status, led, caption, hint, visualState) {
  statusLabel.textContent = status;
  statusLed.className = `status-led ${led}`;
  stageCaption.textContent = caption;
  stageHint.textContent = hint;
  stage.className = `visual-stage ${visualState}`;
}
function showError(message) {
  showedError = true;
  updateStatus("Something went wrong", "", "Let’s try that again", message, "");
}
function cleanupAudio() {
  if (processor) processor.onaudioprocess = null;
  processor?.disconnect(); source?.disconnect(); silentGain?.disconnect();
  outputGain?.disconnect();
  stream?.getTracks().forEach((track) => track.stop());
  stopScheduledPlayback();
  context?.close();
  processor = source = silentGain = outputGain = stream = context = undefined;
  sessionConfigured = false;
  setConnectionOptionsDisabled(false);
  voiceSelect.disabled = false;
  button.classList.remove("stop");
  $("#button-label").textContent = "Start conversation";
  button.disabled = false;
}
function stopConversation() {
  stoppedByUser = true;
  if (socket?.readyState === WebSocket.OPEN) socket.close(1000, "Conversation ended");
  cleanupAudio();
  socket = undefined;
  updateStatus("Ready when you are", "", "Your voice is the interface", "Start a session and say hello", "");
}
