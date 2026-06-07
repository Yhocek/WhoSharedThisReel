import AsyncStorage from '@react-native-async-storage/async-storage';

const CLIPBOARD_STORAGE_KEY = '@reel_game_clipboard_urls';

export interface ClipboardItem {
  url: string;
  addedAt: number;
}

export async function getClipboard(): Promise<ClipboardItem[]> {
  try {
    const data = await AsyncStorage.getItem(CLIPBOARD_STORAGE_KEY);
    if (!data) return [];
    return JSON.parse(data) as ClipboardItem[];
  } catch (error) {
    console.error('Failed to get clipboard:', error);
    return [];
  }
}

export async function addToClipboard(url: string): Promise<ClipboardItem[]> {
  try {
    const current = await getClipboard();
    const normalizedUrl = url.trim();
    if (current.some(item => item.url.toLowerCase() === normalizedUrl.toLowerCase())) {
      return current; // Already exists
    }
    const updated = [{ url: normalizedUrl, addedAt: Date.now() }, ...current];
    await AsyncStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch (error) {
    console.error('Failed to add to clipboard:', error);
    return [];
  }
}

export async function removeFromClipboard(url: string): Promise<ClipboardItem[]> {
  try {
    const current = await getClipboard();
    const normalizedUrl = url.trim().toLowerCase();
    const updated = current.filter(item => item.url.trim().toLowerCase() !== normalizedUrl);
    await AsyncStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch (error) {
    console.error('Failed to remove from clipboard:', error);
    return [];
  }
}

export async function clearClipboard(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CLIPBOARD_STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear clipboard:', error);
  }
}
