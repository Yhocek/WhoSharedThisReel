import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SESSION_KEY = '@whosharedthisreel/session';

interface Session {
  token: string;
  roomId: string;
  playerId: string;
}

/**
 * Persist the current session (JWT + room context) to storage.
 * Uses sessionStorage on web to prevent multi-tab overwrites.
 */
export async function saveSession(
  token: string,
  roomId: string,
  playerId: string,
): Promise<void> {
  const payload: Session = { token, roomId, playerId };
  const serialized = JSON.stringify(payload);

  if (Platform.OS === 'web') {
    try {
      window.sessionStorage.setItem(SESSION_KEY, serialized);
      return;
    } catch (e) {
      console.warn('[Session] sessionStorage write failed, falling back to AsyncStorage', e);
    }
  }

  await AsyncStorage.setItem(SESSION_KEY, serialized);
}

/**
 * Retrieve the full session object, or null if nothing is stored.
 */
export async function getSession(): Promise<Session | null> {
  let raw: string | null = null;

  if (Platform.OS === 'web') {
    try {
      raw = window.sessionStorage.getItem(SESSION_KEY);
    } catch (e) {
      console.warn('[Session] sessionStorage read failed, falling back to AsyncStorage', e);
    }
  }

  if (raw === null) {
    raw = await AsyncStorage.getItem(SESSION_KEY);
  }

  if (!raw) return null;

  try {
    return JSON.parse(raw) as Session;
  } catch {
    // Corrupted data — wipe it
    await clearSession();
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
  if (Platform.OS === 'web') {
    try {
      window.sessionStorage.removeItem(SESSION_KEY);
    } catch (e) {
      console.warn('[Session] sessionStorage remove failed', e);
    }
  }
  await AsyncStorage.removeItem(SESSION_KEY);
}

