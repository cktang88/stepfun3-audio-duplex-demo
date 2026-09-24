# StepAudio 3 realtime demo

## Requirements

- Node.js 20 or newer
- A StepFun API key

## Run locally

Install the dependencies:

```sh
npm install
```

Create a `.env` file in the project root and add your key:

```env
STEPFUN_API_KEY=your_api_key
```

Start the development server:

```sh
npm run dev
```

Open the localhost URL printed by the server in your browser. Microphone access requires a secure context: use HTTPS or localhost, and allow microphone access when prompted.

The WebSocket proxy uses the API key on the server side so it is not exposed in the browser.

Open **Voice settings** in the demo to choose a realtime model, voice, default reply language, and assistant style. The demo defaults to StepAudio 3 Realtime Preview and also offers StepAudio 2.5 Realtime; model access depends on your account. The language defaults to **Match conversation**; choose English or Mandarin Chinese to make it the default, while still allowing the user to ask for another language. StepFun Realtime supports Chinese and English. Changing an option during a conversation clears the transcript and starts a new session with the updated settings. When no session is running, the next conversation uses the selected options.

The clearly marked **Advanced audio options** section includes StepFun's server VAD start buffer, end-of-speech pause, and speech sensitivity settings. It also includes local microphone echo cancellation, noise suppression, automatic gain control, and playback volume. Playback volume responds while you move its slider; releasing the slider starts a fresh session like other option changes.
