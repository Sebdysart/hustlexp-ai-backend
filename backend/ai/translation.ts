import { generateAIResponse } from './router';

const LANGUAGE_CODES: Record<string, string> = {
  'en': 'English',
  'es': 'Spanish',
  'zh': 'Chinese',
  'fr': 'French',
  'de': 'German',
  'pt': 'Portuguese',
  'ar': 'Arabic',
  'hi': 'Hindi',
  'ja': 'Japanese',
  'ko': 'Korean',
};

export async function detectLanguage(text: string): Promise<string> {
  const lowerText = text.toLowerCase();
  
  const spanishPatterns = ['hola', 'gracias', 'por favor', 'sí', 'no', 'buenos', 'días'];
  const chinesePattern = /[\u4e00-\u9fa5]/;
  const arabicPattern = /[\u0600-\u06FF]/;
  
  if (spanishPatterns.some(pattern => lowerText.includes(pattern))) {
    return 'es';
  }
  
  if (chinesePattern.test(text)) {
    return 'zh';
  }
  
  if (arabicPattern.test(text)) {
    return 'ar';
  }
  
  return 'en';
}

export async function translateText(
  text: string,
  targetLang: string,
  sourceLang?: string
): Promise<{
  originalText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
}> {
  const detectedSourceLang = sourceLang || await detectLanguage(text);
  
  if (detectedSourceLang === targetLang) {
    return {
      originalText: text,
      translatedText: text,
      sourceLang: detectedSourceLang,
      targetLang,
    };
  }
  
  console.log(`[Translation] Translating from ${LANGUAGE_CODES[detectedSourceLang]} to ${LANGUAGE_CODES[targetLang]}`);
  
  const response = await generateAIResponse({
    prompt: `Translate this text from ${LANGUAGE_CODES[detectedSourceLang]} to ${LANGUAGE_CODES[targetLang]}: "${text}". 
    Only return the translated text, nothing else.`,
    model: 'qwen3-22b',
    temperature: 0.3,
  });
  
  return {
    originalText: text,
    translatedText: response.text,
    sourceLang: detectedSourceLang,
    targetLang,
  };
}

export async function translateChatMessage(
  message: {
    text: string;
    senderLanguage: string;
    receiverLanguage: string;
  }
): Promise<{
  original: string;
  translated: string;
  sourceLang: string;
  targetLang: string;
}> {
  const { text, senderLanguage, receiverLanguage } = message;
  
  if (senderLanguage === receiverLanguage) {
    return {
      original: text,
      translated: text,
      sourceLang: senderLanguage,
      targetLang: receiverLanguage,
    };
  }
  
  const result = await translateText(text, receiverLanguage, senderLanguage);
  
  return {
    original: result.originalText,
    translated: result.translatedText,
    sourceLang: result.sourceLang,
    targetLang: result.targetLang,
  };
}
