# Speech assets

`reference.wav` — the reference recording "Подготовка модели" measures every model with, and the fixture of the speech tests: 11 s of John F. Kennedy's inaugural address (1961), 16 kHz mono 16-bit PCM, from `samples/jfk.wav` of [whisper.cpp](https://github.com/ggml-org/whisper.cpp). A work of the U.S. federal government, it is in the public domain.

`../catalog.json` — the release catalog of models: every transcribe.cpp 0.3.1 model that transcribes Russian or English, as its Q8_0 GGUF from the handy-computer Hugging Face repositories at a pinned revision, with SHA-256, size, the language tags the model takes, whether it detects the language, its license and upstream model.

The model the tests recognize with is downloaded, not committed: `node scripts/fetch-speech-test-model.mjs`. It is the `whisper-tiny` file of the catalog.
