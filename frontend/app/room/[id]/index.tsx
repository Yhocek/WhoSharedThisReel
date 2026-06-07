import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import api from '../../../lib/api';
import { getSession, clearSession } from '../../../lib/session';
import wsManager from '../../../lib/websocket';
import { useToast } from '../../../components/Toast';
import {
  getClipboard,
  removeFromClipboard,
  ClipboardItem,
} from '../../../lib/clipboard';

type Player = {
  id: string;
  display_name: string;
  player_type: string;
  is_host: boolean;
  is_connected: boolean;
};

type RoomData = {
  code: string;
  status: string;
  max_players: number;
  round_count: number;
  players: Player[];
};

type AddedReel = {
  reel_id: string;
  source_url: string;
};

export default function LobbyScreen() {
  const { id: roomId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [room, setRoom] = useState<RoomData | null>(null);
  const [reelUrl, setReelUrl] = useState('');
  const [addedReels, setAddedReels] = useState<AddedReel[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deletingReelId, setDeletingReelId] = useState<string | null>(null);
  const [selectedRounds, setSelectedRounds] = useState(10);
  const [isHost, setIsHost] = useState(false);
  const [myPlayerId, setMyPlayerId] = useState('');
  const [startError, setStartError] = useState('');
  const [clipboardItems, setClipboardItems] = useState<ClipboardItem[]>([]);
  
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<TextInput>(null);

  const loadLocalClipboard = useCallback(async () => {
    const items = await getClipboard();
    setClipboardItems(items);
  }, []);

  const fetchRoom = useCallback(async () => {
    if (!roomId) return;
    try {
      const res = await api.get(`/rooms/${roomId}`);
      setRoom(res.data);
    } catch (error: any) {
      console.error('Failed to fetch room:', error);
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    // Get session to know if we're host
    getSession().then((session) => {
      if (!session || session.roomId !== roomId) {
        toast.error('Session expired. Please create or join a room.');
        router.replace('/');
        return;
      }
      setMyPlayerId(session.playerId);
    });

    fetchRoom();
    loadLocalClipboard();

    pollRef.current = setInterval(() => {
      fetchRoom();
      loadLocalClipboard();
      api.post(`/rooms/${roomId}/heartbeat`).catch(() => {});
    }, 3000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [roomId, fetchRoom, loadLocalClipboard, router]);

  useEffect(() => {
    if (room && myPlayerId) {
      const me = room.players.find((p) => p.id === myPlayerId);
      setIsHost(me?.is_host ?? false);
    }
  }, [room, myPlayerId]);

  // Connect WebSocket and listen for round_start (game starting)
  useEffect(() => {
    if (!roomId) return;

    wsManager.connect(roomId);

    wsManager.onEvent('round_start', () => {
      // Stop polling, navigate to game
      if (pollRef.current) clearInterval(pollRef.current);
      router.push(`/room/${roomId}/game`);
    });

    return () => {
      wsManager.removeEvent('round_start');
    };
  }, [roomId, router]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text) {
        setReelUrl(text.trim());
        inputRef.current?.focus();
        toast.info('Pasted from clipboard');
      } else {
        toast.info('Nothing to paste');
      }
    } catch (e) {
      toast.error('Could not read clipboard');
    }
  }, [toast]);

  const addVideoToRoom = useCallback(async (url: string, removeFromClipboardOnSuccess = false) => {
    const trimmed = url.trim();
    if (!trimmed) {
      toast.info('Paste a video URL first.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.post(`/rooms/${roomId}/reels`, {
        source_url: trimmed,
      });

      if (res.data?.status === 'already_added') {
        toast.info('This video is already in the pool.');
      } else {
        setAddedReels((prev) => [
          ...prev,
          { reel_id: res.data.reel_id, source_url: trimmed },
        ]);
        toast.success('Video added to pool!');
      }

      if (removeFromClipboardOnSuccess) {
        await removeFromClipboard(trimmed);
        await loadLocalClipboard();
      }

      setReelUrl('');
      fetchRoom();
    } catch (error: any) {
      toast.error(error.response?.data?.detail || 'Failed to add video');
    } finally {
      setSubmitting(false);
    }
  }, [roomId, fetchRoom, toast, loadLocalClipboard]);

  const handleAddReel = useCallback(async () => {
    await addVideoToRoom(reelUrl);
  }, [reelUrl, addVideoToRoom]);

  const handleAddAllFromClipboard = useCallback(async () => {
    setSubmitting(true);
    let successCount = 0;
    for (const item of clipboardItems) {
      try {
        const res = await api.post(`/rooms/${roomId}/reels`, {
          source_url: item.url,
        });
        if (res.data?.status !== 'already_added') {
          setAddedReels((prev) => [
            ...prev,
            { reel_id: res.data.reel_id || `temp-${Date.now()}-${successCount}`, source_url: item.url },
          ]);
        }
        await removeFromClipboard(item.url);
        successCount++;
      } catch (error) {
        // Skip individual errors
      }
    }
    await loadLocalClipboard();
    fetchRoom();
    setSubmitting(false);
    if (successCount > 0) {
      toast.success(`Added ${successCount} video(s) from clipboard!`);
    }
  }, [clipboardItems, roomId, loadLocalClipboard, fetchRoom, toast]);

  const handleRemoveFromClipboard = useCallback(async (url: string) => {
    await removeFromClipboard(url);
    await loadLocalClipboard();
    toast.info('Removed from inbox');
  }, [loadLocalClipboard, toast]);

  const handleDeleteReel = useCallback(
    async (reelId: string) => {
      setDeletingReelId(reelId);
      try {
        await api.delete(`/rooms/${roomId}/vault/${reelId}`);
        setAddedReels((prev) => prev.filter((r) => r.reel_id !== reelId));
        toast.success('Video removed');
        fetchRoom();
      } catch (error: any) {
        toast.error(error.response?.data?.detail || 'Failed to remove Reel');
      } finally {
        setDeletingReelId(null);
      }
    },
    [roomId, fetchRoom, toast],
  );

  const handleStartGame = useCallback(async () => {
    setStartError('');
    try {
      await api.post(`/rooms/${roomId}/start`, {
        round_count: selectedRounds,
      });
      // round_start event from WebSocket will navigate us
    } catch (error: any) {
      const detail = error.response?.data?.detail || 'Failed to start game';
      setStartError(detail);
      toast.error(detail);
    }
  }, [roomId, selectedRounds, toast]);

  const handleLeave = useCallback(async () => {
    try {
      await api.delete(`/rooms/${roomId}/leave`);
      wsManager.disconnect();
      await clearSession();
      toast.info('Left the room');
      router.replace('/');
    } catch (error: any) {
      router.replace('/');
    }
  }, [roomId, router, toast]);

  const copyRoomCode = useCallback(async () => {
    if (room?.code) {
      await Clipboard.setStringAsync(room.code);
      toast.success(`Room code ${room.code} copied!`);
    }
  }, [room, toast]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#E1306C" />
      </View>
    );
  }

  if (!room) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Room not found</Text>
      </View>
    );
  }

  const connectedPlayers = room.players.filter((p) => p.is_connected);

  // Extract a short display from a Reel or TikTok URL
  const reelShortcode = (url: string) => {
    try {
      if (url.toLowerCase().includes('instagram.com')) {
        const match = url.match(/\/(reel|reels|p)\/([A-Za-z0-9_-]+)/);
        return match ? `IG: ${match[2].slice(0, 11)}` : `IG: ${url.slice(-15)}`;
      }
      if (url.toLowerCase().includes('tiktok.com')) {
        const match = url.match(/video\/(\d+)/);
        if (match) return `TT: ${match[1].slice(0, 11)}`;
        const parsed = new URL(url);
        return `TT: ${parsed.pathname.slice(0, 15)}`;
      }
      return url.slice(0, 30);
    } catch {
      return url.slice(0, 30);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {/* Room Code Banner */}
        <TouchableOpacity style={styles.codeBanner} onPress={copyRoomCode} activeOpacity={0.7}>
          <Text style={styles.codeLabel}>ROOM CODE</Text>
          <Text style={styles.codeValue}>{room.code}</Text>
          <Text style={styles.codeTap}>tap to copy</Text>
        </TouchableOpacity>

        {/* Player List */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            Players ({connectedPlayers.length}/{room.max_players})
          </Text>
          {connectedPlayers.map((item) => (
            <View key={item.id} style={styles.playerRow}>
              <View style={styles.playerAvatar}>
                <Text style={styles.playerInitial}>
                  {item.display_name.charAt(0).toUpperCase()}
                </Text>
              </View>
              <Text style={styles.playerName}>{item.display_name}</Text>
              {item.is_host && (
                <View style={styles.hostBadge}>
                  <Text style={styles.hostBadgeText}>HOST</Text>
                </View>
              )}
              {item.id === myPlayerId && (
                <View style={styles.youBadge}>
                  <Text style={styles.youBadgeText}>YOU</Text>
                </View>
              )}
            </View>
          ))}
        </View>

        {/* Add Reel Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Add Videos ({addedReels.length} added)</Text>
          <View style={styles.reelInputRow}>
            <View style={styles.inputWrapper}>
              <TextInput
                ref={inputRef}
                style={styles.reelInput}
                placeholder="Instagram Reel or TikTok URL..."
                placeholderTextColor="#555"
                value={reelUrl}
                onChangeText={setReelUrl}
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
              style={[styles.addButton, submitting && styles.addButtonDisabled]}
              onPress={handleAddReel}
              disabled={submitting}
              activeOpacity={0.7}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.addButtonText}>+</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Clipboard list */}
          {clipboardItems.length > 0 && (
            <View style={styles.clipboardContainer}>
              <View style={styles.clipboardHeader}>
                <Text style={styles.clipboardTitle}>Inbox Clipboard ({clipboardItems.length})</Text>
                <TouchableOpacity onPress={handleAddAllFromClipboard} disabled={submitting}>
                  <Text style={styles.addAllText}>Add All</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.clipboardList}>
                {clipboardItems.map((item) => {
                  const isTiktok = item.url.toLowerCase().includes('tiktok.com');
                  return (
                    <View key={item.url} style={styles.clipboardItem}>
                      <View style={[styles.tag, { backgroundColor: isTiktok ? 'rgba(0, 242, 254, 0.15)' : 'rgba(225, 48, 108, 0.15)' }]}>
                        <Text style={[styles.tagText, { color: isTiktok ? '#00f2fe' : '#E1306C' }]}>
                          {isTiktok ? 'TikTok' : 'Insta'}
                        </Text>
                      </View>
                      <Text style={styles.clipboardText} numberOfLines={1}>
                        {reelShortcode(item.url)}
                      </Text>
                      <View style={styles.clipboardActions}>
                        <TouchableOpacity
                          style={styles.clipAddButton}
                          onPress={() => addVideoToRoom(item.url, true)}
                          disabled={submitting}
                        >
                          <Text style={styles.clipAddText}>Add</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.clipRemoveButton}
                          onPress={() => handleRemoveFromClipboard(item.url)}
                          disabled={submitting}
                        >
                          <Text style={styles.clipRemoveText}>✕</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          )}

          {/* Added Reels List */}
          {addedReels.length > 0 && (
            <View style={styles.reelList}>
              {addedReels.map((reel) => (
                <View key={reel.reel_id} style={styles.reelItem}>
                  <View style={styles.reelIcon}>
                    <Text style={styles.reelIconText}>🎬</Text>
                  </View>
                  <Text style={styles.reelItemText} numberOfLines={1}>
                    {reelShortcode(reel.source_url)}
                  </Text>
                  <TouchableOpacity
                    style={styles.deleteButton}
                    onPress={() => handleDeleteReel(reel.reel_id)}
                    disabled={deletingReelId === reel.reel_id}
                    activeOpacity={0.6}
                  >
                    {deletingReelId === reel.reel_id ? (
                      <ActivityIndicator color="#E1306C" size="small" />
                    ) : (
                      <Text style={styles.deleteButtonText}>✕</Text>
                    )}
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* Actions (pinned to bottom) */}
      <View style={styles.actions}>
        {isHost && (
          <View style={styles.hostSettings}>
            <Text style={styles.sectionTitle}>Round Count</Text>
            <View style={styles.roundOptions}>
              {[10, 20, 30, 50, 100].map((rounds) => (
                <TouchableOpacity
                  key={rounds}
                  style={[styles.roundButton, selectedRounds === rounds && styles.roundButtonActive]}
                  onPress={() => setSelectedRounds(rounds)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.roundButtonText, selectedRounds === rounds && styles.roundButtonTextActive]}>
                    {rounds}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {!!startError && (
              <Text style={{ color: '#E1306C', fontSize: 14, marginBottom: 8 }}>
                {startError}
              </Text>
            )}
            <TouchableOpacity
              style={styles.startButton}
              onPress={handleStartGame}
              activeOpacity={0.8}
            >
              <Text style={styles.startButtonText}>Start Game</Text>
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity style={styles.leaveButton} onPress={handleLeave} activeOpacity={0.8}>
          <Text style={styles.leaveButtonText}>Leave Room</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0F',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 24,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0A0A0F',
  },
  errorText: {
    color: '#E1306C',
    fontSize: 18,
    fontWeight: '600',
  },
  codeBanner: {
    alignItems: 'center',
    paddingVertical: 20,
    marginHorizontal: 24,
    marginTop: 8,
    backgroundColor: '#16161F',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2A2A3A',
  },
  codeLabel: {
    color: '#888',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
  },
  codeValue: {
    color: '#fff',
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: 8,
    marginTop: 4,
  },
  codeTap: {
    color: '#555',
    fontSize: 11,
    marginTop: 4,
  },
  section: {
    marginTop: 20,
    paddingHorizontal: 24,
  },
  sectionTitle: {
    color: '#888',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  playerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16161F',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#2A2A3A',
    marginBottom: 8,
  },
  playerAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#405DE6',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  playerInitial: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  playerName: {
    color: '#fff',
    fontSize: 16,
    flex: 1,
  },
  hostBadge: {
    backgroundColor: '#E1306C',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    marginLeft: 8,
  },
  hostBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
  },
  youBadge: {
    backgroundColor: '#405DE6',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    marginLeft: 8,
  },
  youBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
  },
  reelInputRow: {
    flexDirection: 'row',
    gap: 10,
  },
  inputWrapper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0E0E16',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A3A',
    overflow: 'hidden',
  },
  reelInput: {
    flex: 1,
    height: 48,
    paddingHorizontal: 14,
    fontSize: 14,
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
    fontSize: 18,
  },
  addButton: {
    width: 48,
    height: 48,
    backgroundColor: '#E1306C',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addButtonDisabled: {
    opacity: 0.5,
  },
  addButtonText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
  },
  reelList: {
    marginTop: 12,
    gap: 6,
  },
  reelItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16161F',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#2A2A3A',
  },
  reelIcon: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: '#1A1A2E',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  reelIconText: {
    fontSize: 14,
  },
  reelItemText: {
    flex: 1,
    color: '#aaa',
    fontSize: 13,
    fontWeight: '500',
  },
  deleteButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  deleteButtonText: {
    color: '#E1306C',
    fontSize: 16,
    fontWeight: '800',
  },
  actions: {
    padding: 24,
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: '#1A1A2A',
  },
  hostSettings: {
    gap: 12,
  },
  roundOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  roundButton: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#16161F',
    borderWidth: 1,
    borderColor: '#2A2A3A',
  },
  roundButtonActive: {
    backgroundColor: '#E1306C',
    borderColor: '#E1306C',
  },
  roundButtonText: {
    color: '#888',
    fontSize: 14,
    fontWeight: '600',
  },
  roundButtonTextActive: {
    color: '#fff',
  },
  startButton: {
    height: 52,
    backgroundColor: '#405DE6',
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  startButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
  },
  leaveButton: {
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  leaveButtonText: {
    color: '#E1306C',
    fontSize: 14,
    fontWeight: '600',
  },
  // Clipboard styling
  clipboardContainer: {
    marginTop: 16,
    backgroundColor: '#16161F',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#2A2A3A',
  },
  clipboardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  clipboardTitle: {
    color: '#888',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  addAllText: {
    color: '#10B981',
    fontSize: 12,
    fontWeight: '700',
  },
  clipboardList: {
    gap: 8,
  },
  clipboardItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0E0E16',
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: '#2A2A3A',
  },
  clipboardText: {
    color: '#ddd',
    fontSize: 12,
    flex: 1,
  },
  clipboardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  clipAddButton: {
    backgroundColor: '#10B981',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  clipAddText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  clipRemoveButton: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  clipRemoveText: {
    color: '#EF4444',
    fontSize: 12,
    fontWeight: '700',
  },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 6,
  },
  tagText: {
    fontSize: 9,
    fontWeight: '700',
  },
});
