"""AI Voice Photo voice service.

One isolated Python process that owns everything audio/model related:

    microphone -> Silero VAD -> faster-whisper      (speech in)
    text -> Silero TTS -> speakers                  (speech out)

It talks to the application core over a JSON-lines protocol on stdin/stdout.
"""

PROTOCOL_VERSION = 1
# optional capabilities announced in `hello` (the protocol version stays 1)
#   tts_return  tts_speak with deliver="return": the synthesized chunk comes back as a
#               binary `tts_audio` event (16-bit PCM WAV) instead of being played (VC-M3.2)
FEATURES = ("tts_return",)
