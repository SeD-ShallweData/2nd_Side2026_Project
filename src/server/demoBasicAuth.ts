export type DemoAuthConfiguration =
  | { status: "disabled" }
  | { status: "invalid" }
  | { status: "enabled"; username: string; password: string };

export function getDemoAuthConfiguration(
  username = process.env.DEMO_BASIC_AUTH_USER,
  password = process.env.DEMO_BASIC_AUTH_PASSWORD,
): DemoAuthConfiguration {
  if (!username && !password) {
    return { status: "disabled" };
  }

  if (!username || !password) {
    return { status: "invalid" };
  }

  return { status: "enabled", username, password };
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const maximumLength = Math.max(actual.length, expected.length);
  let difference = actual.length ^ expected.length;

  for (let index = 0; index < maximumLength; index += 1) {
    difference |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }

  return difference === 0;
}

export function isValidBasicAuthorization(
  authorization: string | null,
  expectedUsername: string,
  expectedPassword: string,
): boolean {
  if (!authorization?.startsWith("Basic ")) {
    return false;
  }

  try {
    const decoded = atob(authorization.slice("Basic ".length));
    const separatorIndex = decoded.indexOf(":");

    if (separatorIndex < 0) {
      return false;
    }

    return (
      constantTimeEqual(decoded.slice(0, separatorIndex), expectedUsername) &&
      constantTimeEqual(decoded.slice(separatorIndex + 1), expectedPassword)
    );
  } catch {
    return false;
  }
}
