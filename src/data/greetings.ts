export interface Greeting {
  text: string;
  lang: string;
  region: string;
}

export const GREETINGS: Greeting[] = [
  { text: "HELLO WORLD", lang: "English", region: "EN-US" },
  { text: "你好，世界", lang: "中文", region: "ZH-CN" },
  { text: "こんにちは、世界", lang: "日本語", region: "JA-JP" },
  { text: "안녕, 세상", lang: "한국어", region: "KO-KR" },
  { text: "Hola, Mundo", lang: "Español", region: "ES-ES" },
  { text: "Bonjour, Monde", lang: "Français", region: "FR-FR" },
  { text: "Hallo, Welt", lang: "Deutsch", region: "DE-DE" },
  { text: "Ciao, Mondo", lang: "Italiano", region: "IT-IT" },
  { text: "Olá, Mundo", lang: "Português", region: "PT-BR" },
  { text: "Привет, мир", lang: "Русский", region: "RU-RU" },
  { text: "नमस्ते दुनिया", lang: "हिन्दी", region: "HI-IN" },
  { text: "مرحبا يا عالم", lang: "العربية", region: "AR-SA" },
];

export const TICKER_TEXT = GREETINGS.map((g) => g.text).join("  ✳  ");

export const BURST_GLYPHS = ["{ }", "</>", "01", "=>", "fn", "#!", "&&", "++", "h5", "::"];

export const FIELD_GLYPHS = ["{", "}", "</>", "=>", "0", "1", ";", "fn", "#", "(", ")", "let", "∞", "✓"];
