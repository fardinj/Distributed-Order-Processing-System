import Keycloak from '/ui/vendor/keycloak.js';
let adapter;
export async function initialize() {
  const response = await fetch('/auth/config');
  if (!response.ok) throw new Error('تنظیمات ورود در دسترس نیست. کمی بعد صفحه را تازه کنید.');
  const settings = await response.json();
  const issuer = new URL(settings.issuer);
  adapter = new Keycloak({
    url: issuer.origin + '/identity',
    realm: 'tops',
    clientId: settings.clientId,
  });
  await adapter.init({
    onLoad: 'check-sso',
    pkceMethod: 'S256',
    checkLoginIframe: false,
    responseMode: 'query',
    redirectUri: location.origin + '/auth/callback',
  });
  return adapter.authenticated;
}
export async function token() {
  if (!adapter?.authenticated) throw new Error('برای ادامه دوباره وارد شوید.');
  try {
    await adapter.updateToken(30);
  } catch {
    adapter.clearToken();
    throw new Error('نشست شما پایان یافته؛ دوباره وارد شوید.');
  }
  return adapter.token;
}
export function login() {
  sessionStorage.setItem('tops:return', location.hash || '#catalog');
  return adapter.login({ redirectUri: location.origin + '/auth/callback', locale: 'fa' });
}
export function logout() {
  return adapter.logout({ redirectUri: location.origin + '/' });
}
export const username = () => adapter?.tokenParsed?.preferred_username;
export function onSignOut(callback) {
  adapter.onAuthLogout = callback;
}
