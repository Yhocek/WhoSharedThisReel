import AsyncStorage from '@react-native-async-storage/async-storage';

const SESSION_KEY = '@whosharedthisreel/session';

interface Session {
  token: string;
  roomId: string;
  playerId: string;
}

/**
 * Persist the current session (JWT + room context) to AsyncStorage.
 */
export async function saveSession(
  token: string,
  roomId: string,
  playerId: string,
): Promise<void> {
  const payload: Session = { token, roomId, playerId };
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(payload));
}

/**
 * Retrieve the full session object, or null if nothing is stored.
 */
export async function getSession(): Promise<Session | null> {
  const raw = await AsyncStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    // Corrupted data — wipe it
    await AsyncStorage.removeItem(SESSION_KEY);
    return null;
  }
}

/**
 * Convenience helper — returns just the JWT string (or null).
 */
export async function getToken(): Promise<string | null> {
  const session = await getSession();
  return session?.token ?? null;
}

/**
 * Remove the persisted session entirely.
 */
export async function clearSession(): Promise<void> {
  await AsyncStorage.removeItem(SESSION_KEY);
}
