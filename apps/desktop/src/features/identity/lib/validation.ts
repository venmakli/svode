const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function isValidName(name: string): boolean {
  return name.trim().length > 0;
}

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}
