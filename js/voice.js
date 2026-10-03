const ERROR_MESSAGES = {
  'not-allowed': 'マイクの使用が許可されていません',
  'service-not-allowed': 'マイクの使用が許可されていません',
  'no-speech': '音声が検出されませんでした',
  network: 'ネットワークエラーです',
  'audio-capture': 'マイクが見つかりません',
  aborted: '中断されました',
  'not-supported': 'このブラウザは音声入力に対応していません',
};

function getRecognitionClass() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function toErrorMessage(code) {
  return ERROR_MESSAGES[code] || `認識エラー(${code})`;
}

export function isVoiceSupported() {
  return getRecognitionClass() !== null;
}

export function createRecognizer({ lang = 'ja-JP', onResult, onEnd, onError } = {}) {
  let recognition = null;
  let listening = false;

  const emitError = (code) => {
    if (typeof onError === 'function') onError(code, toErrorMessage(code));
  };

  const finish = () => {
    if (!listening) return;
    listening = false;
    recognition = null;
    if (typeof onEnd === 'function') onEnd();
  };

  const handleResult = (event) => {
    if (typeof onResult !== 'function') return;
    let text = '';
    let isFinal = false;
    for (let i = 0; i < event.results.length; i += 1) {
      const res = event.results[i];
      if (res[0]) text += res[0].transcript;
      isFinal = Boolean(res.isFinal);
    }
    text = text.trim();
    if (text) onResult(text, isFinal);
  };

  return {
    start() {
      if (listening) return;
      const Recognition = getRecognitionClass();
      if (!Recognition) {
        emitError('not-supported');
        return;
      }
      recognition = new Recognition();
      recognition.lang = lang;
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;
      recognition.onresult = handleResult;
      recognition.onerror = (event) => emitError(event && event.error ? event.error : 'unknown');
      recognition.onend = finish;
      listening = true;
      try {
        recognition.start();
      } catch (err) {
        emitError('start-failed');
        finish();
      }
    },
    stop() {
      if (!listening || !recognition) return;
      try {
        recognition.stop();
      } catch (err) {
        finish();
      }
    },
    get listening() {
      return listening;
    },
  };
}
