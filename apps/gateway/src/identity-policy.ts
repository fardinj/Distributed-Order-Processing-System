export function identityPathAllowed(path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (decoded.includes('\\') || decoded.includes('%') || decoded.includes('\0')) return false;
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  return decoded.startsWith('/identity/realms/tops/') || decoded.startsWith('/identity/resources/');
}
