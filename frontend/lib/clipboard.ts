import AsyncStorage from '@react-native-async-storage/async-storage';

const CLIPBOARD_STORAGE_KEY = '@reel_game_clipboard_urls';

export interface ClipboardItem {
  url: string;
  addedAt: number;
  note?: string;
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

export async function addToClipboard(url: string, note?: string): Promise<ClipboardItem[]> {
  try {
    const current = await getClipboard();
    const normalizedUrl = url.trim();
    if (current.some(item => item.url.toLowerCase() === normalizedUrl.toLowerCase())) {
      if (note !== undefined) {
        return updateClipboardNote(normalizedUrl, note);
      }
      return current; // Already exists
    }
    const updated = [{ url: normalizedUrl, addedAt: Date.now(), note }, ...current];
    await AsyncStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch (error) {
    console.error('Failed to add to clipboard:', error);
    return [];
  }
}

/**
 * Add multiple URLs to clipboard in one batch write.
 * Returns the count of newly added (non-duplicate) URLs.
 */
export async function addMultipleToClipboard(
  urls: string[]
): Promise<{ items: ClipboardItem[]; addedCount: number }> {
  try {
    const current = await getClipboard();
    const existingSet = new Set(current.map(item => item.url.toLowerCase()));
    const newItems: ClipboardItem[] = [];
    const now = Date.now();

    for (const url of urls) {
      const normalized = url.trim();
      const key = normalized.toLowerCase();
      if (!existingSet.has(key)) {
        existingSet.add(key);
        newItems.push({ url: normalized, addedAt: now });
      }
    }

    if (newItems.length === 0) {
      return { items: current, addedCount: 0 };
    }

    const updated = [...newItems, ...current];
    await AsyncStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(updated));
    return { items: updated, addedCount: newItems.length };
  } catch (error) {
    console.error('Failed to add multiple to clipboard:', error);
    return { items: [], addedCount: 0 };
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

export async function updateClipboardNote(url: string, note: string): Promise<ClipboardItem[]> {
  try {
    const current = await getClipboard();
    const normalizedUrl = url.trim().toLowerCase();
    const updated = current.map(item => {
      if (item.url.trim().toLowerCase() === normalizedUrl) {
        return { ...item, note: note.trim() };
      }
      return item;
    });
    await AsyncStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch (error) {
    console.error('Failed to update clipboard note:', error);
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

