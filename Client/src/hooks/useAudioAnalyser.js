import { useCallback, useEffect, useRef, useState } from "react";

const FFT_SIZE = 256;
const SMOOTHING_TIME_CONSTANT = 0.75;
const LEVEL_MULTIPLIER = 3.5;

/*
 * Voice activity settings
 */
const SPEECH_THRESHOLD = 0.035;
const SILENCE_DURATION = 1500;

function useAudioAnalyser() {
  const [isActive, setIsActive] = useState(false);
  const [level, setLevel] = useState(0);
  const [frequencyData, setFrequencyData] = useState([]);
  const [error, setError] = useState(null);

  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animationFrameRef = useRef(null);

  const timeDomainDataRef = useRef(null);
  const frequencyDataRef = useRef(null);

  /*
   * Voice activity state
   */
  const hasDetectedSpeechRef = useRef(false);
  const silenceStartRef = useRef(null);

  /*
   * Called when the user has stopped speaking.
   */
  const handleSilenceRef = useRef(null);

  /*
   * MediaRecorder refs for raw audio capturing
   */
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const onAudioReadyRef = useRef(null);

  const stop = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        // ignore errors on early stop
      }
      mediaRecorderRef.current = null;
    }

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(
        animationFrameRef.current,
      );

      animationFrameRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current
        .getTracks()
        .forEach((track) => {
          track.stop();
        });

      streamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    analyserRef.current = null;
    timeDomainDataRef.current = null;
    frequencyDataRef.current = null;

    /*
     * Reset voice activity state.
     */
    hasDetectedSpeechRef.current = false;
    silenceStartRef.current = null;

    setIsActive(false);
    setLevel(0);
    setFrequencyData([]);
  }, []);

  const start = useCallback(async () => {
    if (isActive) {
      return;
    }

    try {
      setError(null);

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Microphone access is not supported by this browser.",
        );
      }

      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

      // Set up MediaRecorder to capture audio chunks
      const audioChunks = [];
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };
      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunks, { type: "audio/wav" });
        if (onAudioReadyRef.current) {
          onAudioReadyRef.current(audioBlob);
        }
      };
      mediaRecorder.start();
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = audioChunks;

      const AudioContext =
        window.AudioContext ||
        window.webkitAudioContext;

      if (!AudioContext) {
        stream
          .getTracks()
          .forEach((track) => track.stop());

        throw new Error(
          "Web Audio API is not supported by this browser.",
        );
      }

      const audioContext = new AudioContext();

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      const analyser =
        audioContext.createAnalyser();

      analyser.fftSize = FFT_SIZE;

      analyser.smoothingTimeConstant =
        SMOOTHING_TIME_CONSTANT;

      const source =
        audioContext.createMediaStreamSource(
          stream,
        );

      source.connect(analyser);

      const timeDomainData = new Uint8Array(
        analyser.fftSize,
      );

      const frequencyData = new Uint8Array(
        analyser.frequencyBinCount,
      );

      streamRef.current = stream;
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      timeDomainDataRef.current =
        timeDomainData;

      frequencyDataRef.current =
        frequencyData;

      /*
       * Reset voice activity state.
       */
      hasDetectedSpeechRef.current = false;
      silenceStartRef.current = null;

      setIsActive(true);

      const updateAudioData = () => {
        const currentAnalyser =
          analyserRef.current;

        const currentTimeDomainData =
          timeDomainDataRef.current;

        const currentFrequencyData =
          frequencyDataRef.current;

        if (
          !currentAnalyser ||
          !currentTimeDomainData ||
          !currentFrequencyData
        ) {
          return;
        }

        /*
         * ===============================
         * RMS / VOICE LEVEL
         * ===============================
         */

        currentAnalyser.getByteTimeDomainData(
          currentTimeDomainData,
        );

        let sum = 0;

        for (const value of currentTimeDomainData) {
          const normalized =
            (value - 128) / 128;

          sum += normalized * normalized;
        }

        const rms = Math.sqrt(
          sum /
            currentTimeDomainData.length,
        );

        const normalizedLevel = Math.min(
          1,
          rms * LEVEL_MULTIPLIER,
        );

        setLevel(normalizedLevel);

        /*
         * ===============================
         * VOICE ACTIVITY DETECTION
         * ===============================
         */

        const isSpeech =
          rms >= SPEECH_THRESHOLD;

        if (isSpeech) {
          /*
           * The user is speaking.
           *
           * Once speech has been detected,
           * silence detection becomes active.
           */
          hasDetectedSpeechRef.current = true;

          /*
           * Reset silence timer immediately.
           */
          silenceStartRef.current = null;
        } else if (
          hasDetectedSpeechRef.current
        ) {
          /*
           * User has already spoken and is now
           * quiet.
           */
          if (
            silenceStartRef.current === null
          ) {
            silenceStartRef.current =
              performance.now();
          } else {
            const silenceDuration =
              performance.now() -
              silenceStartRef.current;

            /*
             * Enough silence has passed.
             */
            if (
              silenceDuration >=
              SILENCE_DURATION
            ) {
              /*
               * Reset before stopping so the
               * callback cannot repeatedly fire.
               */
              hasDetectedSpeechRef.current =
                false;

              silenceStartRef.current = null;

              handleSilenceRef.current?.();

              return;
            }
          }
        }

        /*
         * ===============================
         * FREQUENCY SPECTRUM
         * ===============================
         */

        currentAnalyser.getByteFrequencyData(
          currentFrequencyData,
        );

        setFrequencyData(
          Array.from(currentFrequencyData),
        );

        animationFrameRef.current =
          requestAnimationFrame(
            updateAudioData,
          );
      };

      updateAudioData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to access the microphone.",
      );

      stop();
    }
  }, [isActive, stop]);

  /*
   * Expose a callback that VoiceExperience
   * can register.
   */
  const onSilence = useCallback(
    (callback) => {
      handleSilenceRef.current = callback;
    },
    [],
  );

  const onAudioReady = useCallback(
    (callback) => {
      onAudioReadyRef.current = callback;
    },
    [],
  );

  useEffect(() => {
    return () => {
      stop();
      handleSilenceRef.current = null;
      onAudioReadyRef.current = null;
    };
  }, [stop]);

  return {
    isActive,
    level,
    frequencyData,
    error,
    start,
    stop,
    onSilence,
    onAudioReady,
  };
}

export default useAudioAnalyser;