// ============================================================================
// CONFIGURAÇÃO TÉCNICA (SUPABASE CLOUD + GEMINI API)
// ============================================================================

let localSecrets = {};
try {
  const mod = await import('./config.local.js');
  localSecrets = mod.LOCAL_SECRETS || {};
} catch (e) {
  // Em produção/GitHub sem config.local.js, lê de localStorage
}

export const ENV_CONFIG = {
  SUPABASE_URL: 'https://mvuetclsmbmjwakwlvwi.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_6n8q4lq47EOPoDm9OOnNcw_Zi4L0qck',
  SUPABASE_JWKS_URL: 'https://mvuetclsmbmjwakwlvwi.supabase.co/auth/v1/.well-known/jwks.json',
  GEMINI_API_KEY: localSecrets.GEMINI_API_KEY || localStorage.getItem('ma_gemini_api_key') || '',
  GEMINI_MODEL: 'gemini-3-flash-preview',
  AI_PROVIDER: 'gemini'
};
