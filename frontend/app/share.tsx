import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Animated,
  ScrollView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import api from '../lib/api';
import { getSession } from '../lib/session';
import { useToast } from '../components/Toast';
import {
  getClipboard,
  addToClipboard,
  removeFromClipboard,
  clearClipboard,
  ClipboardItem,
} from '../lib/clipboard';

type ShareStatus = 'loading' | 'ready';

export default function ShareScreen() {
  const params = useLocalSearchParams<{ url?: string; text?: string }>();
  const router = useRouter();
  const toast = useToast();

  const [status, setStatus] = useState<ShareStatus>('loading');
  const [urlInput, setUrlInput] = useState('');
  const [roomId, setRoomId] = useState('');
  const [clipboardItems, setClipboardItems] = useState<ClipboardItem[]>([]);
  const [submittingItem, setSubmittingItem] = useState<string | null>(null);
  const [isSubmittingAll, setIsSubmittingAll] = useState(false);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.95)).current;

  // Extract an Instagram or TikTok URL from text
  const extractMediaUrl = useCallback((text: string): string | null => {
    // Match Instagram Reel/Post
    const instaMatch = text.match(
      /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p)\/[A-Za-z0-9_-]+\/?[^\s]*/i
    );
    if (instaMatch) return instaMatch[0];

    // Match TikTok Video
    const tiktokMatch = text.match(
      /https?:\/\/(?:[a-zA-Z0-9-]+\.)?tiktok\.com\/[A-Za-z0-9_.\/@-]+/i
    );
    if (tiktokMatch) return tiktokMatch[0];

    return null;
  }, []);

  const loadClipboard = useCallback(async () => {
    const items = await getClipboard();
    setClipboardItems(items);
  }, []);

  // On mount: check session, extract URL and load clipboard
  useEffect(() => {
    (async () => {
      // 1. Load session
      const session = await getSession();
      if (session?.roomId) {
        setRoomId(session.roomId);
      }

      // 2. Try to get URL from query params/share intent
      const rawUrl = params.url || params.text || '';
      if (rawUrl) {
        const extracted = extractMediaUrl(rawUrl);
        if (extracted) {
          await addToClipboard(extracted);
          toast.success('Added shared link to Inbox!');
        } else {
          // If not matched, still try adding if it looks like a URL
          const trimmed = rawUrl.trim();
          if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            await addToClipboard(trimmed);
            toast.success('Added shared link to Inbox!');
          } else {
            toast.error('Shared text does not contain a valid Reels or TikTok link.');
          }
        }
      }

      // 3. Load clipboard list
      await loadClipboard();
      setStatus('ready');
      animateIn();
    })();
  }, [params.url, params.text]);

  const animateIn = () => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        tension: 100,
        friction: 12,
        useNativeDriver: true,
      }),
    ]).start();
  };

  const handleAddManual = async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) {
      toast.info('Paste or type a video URL first.');
      return;
    }

    const extracted = extractMediaUrl(trimmed);
    const urlToAdd = extracted || trimmed;

    if (!urlToAdd.startsWith('http://') && !urlToAdd.startsWith('https://')) {
      toast.error('Please enter a valid URL starting with http:// or https://');
      return;
    }

    const updated = await addToClipboard(urlToAdd);
    setClipboardItems(updated);
    setUrlInput('');
    toast.success('Added to Inbox!');
  };

  const handlePaste = useCallback(async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text) {
        const extracted = extractMediaUrl(text);
        setUrlInput(extracted || text.trim());
        toast.info('Pasted from device clipboard');
      } else {
        toast.info('Device clipboard is empty');
      }
    } catch {
      toast.error('Could not read device clipboard');
    }
  }, [extractMediaUrl, toast]);

  const handleRemoveItem = async (url: string) => {
    const updated = await removeFromClipboard(url);
    setClipboardItems(updated);
    toast.info('Removed from Inbox');
  };

  const handleClearAll = async () => {
    await clearClipboard();
    setClipboardItems([]);
    toast.info('Inbox cleared');
  };

  const handleAddToRoom = async (url: string) => {
    if (!roomId) {
      toast.error('You must join or create a room first.');
      return;
    }

    setSubmittingItem(url);
    try {
      const res = await api.post(`/rooms/${roomId}/reels`, {
        source_url: url,
      });

      if (res.data?.status === 'already_added') {
        toast.info('This video was already in the room vault!');
      } else {
        toast.success('Added to room vault! 🎬');
      }

      // Remove from clipboard upon successful insertion
      const updated = await removeFromClipboard(url);
      setClipboardItems(updated);
    } catch (error: any) {
      const detail = error.response?.data?.detail || 'Failed to add video';
      toast.error(detail);
    } finally {
      setSubmittingItem(null);
    }
  };

  const handleAddAllToRoom = async () => {
    if (!roomId) {
      toast.error('You must join or create a room first.');
      return;
    }

    setIsSubmittingAll(true);
    let successCount = 0;
    let failCount = 0;

    for (const item of clipboardItems) {
      try {
        await api.post(`/rooms/${roomId}/reels`, {
          source_url: item.url,
        });
        await removeFromClipboard(item.url);
        successCount++;
      } catch (error) {
        failCount++;
      }
    }

    await loadClipboard();
    setIsSubmittingAll(false);

    if (successCount > 0) {
      toast.success(`Added ${successCount} video(s) to room!`);
    }
    if (failCount > 0) {
      toast.error(`Failed to add ${failCount} video(s).`);
    }
  };

  const getUrlDomainLabel = (url: string) => {
    if (url.toLowerCase().includes('instagram.com')) {
      return { label: 'Instagram', color: '#E1306C', bg: 'rgba(225, 48, 108, 0.15)' };
    }
    if (url.toLowerCase().includes('tiktok.com')) {
      return { label: 'TikTok', color: '#00f2fe', bg: 'rgba(0, 242, 254, 0.15)' };
    }
    return { label: 'Link', color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.15)' };
  };

  const getDisplayUrl = (url: string) => {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname;
      if (pathname.length > 30) {
        return parsed.hostname + pathname.substring(0, 25) + '...';
      }
      return parsed.hostname + pathname;
    } catch {
      if (url.length > 35) {
        return url.substring(0, 32) + '...';
      }
      return url;
    }
  };

  if (status === 'loading') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#7C3AED" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Animated.View
          style={[styles.content, { opacity: fadeAnim, transform: [{ scale: scaleAnim }] }]}
        >
          {/* Header Section */}
          <View style={styles.headerSection}>
            <Text style={styles.icon}>📥</Text>
            <Text style={styles.title}>Media Inbox</Text>
            <Text style={styles.subtitle}>
              Collect Instagram Reels or TikTok videos here. Add them to your active room whenever you want.
            </Text>
          </View>

          {/* Active Session Status Card */}
          {roomId ? (
            <View style={styles.sessionCard}>
              <View style={styles.sessionInfo}>
                <Text style={styles.sessionLabel}>ACTIVE ROOM</Text>
                <Text style={styles.sessionValue}>{roomId}</Text>
              </View>
              <TouchableOpacity
                style={styles.lobbyButton}
                onPress={() => router.replace(`/room/${roomId}`)}
                activeOpacity={0.7}
              >
                <Text style={styles.lobbyButtonText}>Go to Lobby →</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.noSessionCard}>
              <Text style={styles.noSessionText}>
                ⚠️ No active room. You can still collect links in your Inbox and add them to a room later!
              </Text>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={() => router.replace('/')}
                activeOpacity={0.8}
              >
                <Text style={styles.primaryButtonText}>Join / Create Room</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Input Card */}
          <View style={styles.card}>
            <Text style={styles.inputLabel}>ADD LINK MANUALLY</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                placeholder="Paste Instagram Reel or TikTok link..."
                placeholderTextColor="#666"
                value={urlInput}
                onChangeText={setUrlInput}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={styles.pasteButton}
                onPress={handlePaste}
                activeOpacity={0.7}
              >
                <Text style={styles.pasteButtonText}>📋</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.collectButton}
              onPress={handleAddManual}
              activeOpacity={0.8}
            >
              <Text style={styles.collectButtonText}>Add to Inbox</Text>
            </TouchableOpacity>
          </View>

          {/* Inbox List Section */}
          <View style={styles.listSection}>
            <View style={styles.listHeader}>
              <Text style={styles.listTitle}>Collected Links ({clipboardItems.length})</Text>
              {clipboardItems.length > 0 && (
                <TouchableOpacity onPress={handleClearAll} activeOpacity={0.7}>
                  <Text style={styles.clearAllText}>Clear All</Text>
                </TouchableOpacity>
              )}
            </View>

            {clipboardItems.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyIcon}>📦</Text>
                <Text style={styles.emptyTitle}>Inbox is Empty</Text>
                <Text style={styles.emptySubtitle}>
                  Links you share from Instagram or TikTok will appear here. Or copy/paste a link above.
                </Text>
              </View>
            ) : (
              <View style={styles.itemsContainer}>
                {clipboardItems.map((item) => {
                  const tag = getUrlDomainLabel(item.url);
                  const isItemSubmitting = submittingItem === item.url;

                  return (
                    <View key={item.url} style={styles.itemRow}>
                      <View style={styles.itemInfo}>
                        <View style={[styles.tag, { backgroundColor: tag.bg }]}>
                          <Text style={[styles.tagText, { color: tag.color }]}>{tag.label}</Text>
                        </View>
                        <Text style={styles.itemUrl} numberOfLines={1}>
                          {getDisplayUrl(item.url)}
                        </Text>
                      </View>

                      <View style={styles.actions}>
                        {roomId && (
                          <TouchableOpacity
                            style={styles.actionAddButton}
                            onPress={() => handleAddToRoom(item.url)}
                            disabled={!!submittingItem || isSubmittingAll}
                            activeOpacity={0.7}
                          >
                            {isItemSubmitting ? (
                              <ActivityIndicator size="small" color="#fff" />
                            ) : (
                              <Text style={styles.actionAddText}>Add to Room</Text>
                            )}
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity
                          style={styles.actionRemoveButton}
                          onPress={() => handleRemoveItem(item.url)}
                          disabled={!!submittingItem || isSubmittingAll}
                          activeOpacity={0.7}
                        >
                          <Text style={styles.actionRemoveText}>🗑️</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}

                {roomId && clipboardItems.length > 0 && (
                  <TouchableOpacity
                    style={[styles.addAllButton, isSubmittingAll && styles.disabledButton]}
                    onPress={handleAddAllToRoom}
                    disabled={isSubmittingAll || !!submittingItem}
                    activeOpacity={0.8}
                  >
                    {isSubmittingAll ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.addAllButtonText}>
                        Add All to Room ({clipboardItems.length})
                      </Text>
                    )}
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0F',
  },
  scrollContent: {
    flexGrow: 1,
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  content: {
    width: '100%',
    maxWidth: 500,
    alignSelf: 'center',
  },
  headerSection: {
    alignItems: 'center',
    marginBottom: 24,
  },
  icon: {
    fontSize: 48,
    marginBottom: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: '900',
    color: '#fff',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 360,
  },
  sessionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(124, 58, 237, 0.1)',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(124, 58, 237, 0.3)',
    marginBottom: 20,
  },
  sessionInfo: {
    flex: 1,
  },
  sessionLabel: {
    color: '#a78bfa',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
  },
  sessionValue: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    marginTop: 2,
  },
  lobbyButton: {
    backgroundColor: '#7C3AED',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  lobbyButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  noSessionCard: {
    backgroundColor: '#16161F',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2A2A3A',
    marginBottom: 20,
  },
  noSessionText: {
    color: '#aaa',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  primaryButton: {
    height: 44,
    backgroundColor: '#3B82F6',
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 12,
    width: '100%',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  card: {
    backgroundColor: '#16161F',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#2A2A3A',
    marginBottom: 24,
  },
  inputLabel: {
    color: '#888',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0E0E16',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A3A',
    overflow: 'hidden',
  },
  input: {
    flex: 1,
    height: 48,
    paddingHorizontal: 14,
    fontSize: 13,
    color: '#fff',
  },
  pasteButton: {
    width: 44,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderLeftWidth: 1,
    borderLeftColor: '#2A2A3A',
  },
  pasteButtonText: {
    fontSize: 16,
  },
  collectButton: {
    height: 44,
    backgroundColor: '#7C3AED',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 12,
  },
  collectButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  listSection: {
    backgroundColor: '#16161F',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#2A2A3A',
  },
  listHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  listTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },
  clearAllText: {
    color: '#EF4444',
    fontSize: 12,
    fontWeight: '600',
  },
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: 12,
    opacity: 0.6,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#888',
    marginBottom: 4,
  },
  emptySubtitle: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center',
    lineHeight: 18,
    maxWidth: 280,
  },
  itemsContainer: {
    gap: 12,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0E0E16',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#2A2A3A',
  },
  itemInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
  },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginRight: 8,
  },
  tagText: {
    fontSize: 10,
    fontWeight: '700',
  },
  itemUrl: {
    color: '#ddd',
    fontSize: 13,
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actionAddButton: {
    backgroundColor: '#10B981',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 80,
  },
  actionAddText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  actionRemoveButton: {
    backgroundColor: '#2A2A3A',
    width: 28,
    height: 28,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionRemoveText: {
    fontSize: 12,
  },
  addAllButton: {
    height: 48,
    backgroundColor: '#10B981',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  addAllButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.6,
  },
});
