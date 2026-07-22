/** 审计与远端调用前的最小 secret redaction。 */

const SECRET_KEY = /(authorization|cookie|token|secret|password|api[_-]?key|credential)/iu;

export function redactEnvironment(environment: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
	return Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : value]));
}

export function redactHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
	return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : value]));
}

export function environmentKeyDigests(
	environment: Readonly<Record<string, string>>,
	digest: (value: string) => string,
): readonly string[] {
	return Object.keys(environment).map((key) => digest(key)).sort();
}
