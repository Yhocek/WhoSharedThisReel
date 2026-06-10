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
  Modal,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import api, { extractErrorMessage } from '../../../lib/api';
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
  vault_counts?: Record<string, number>;
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
  const [chatMessages, setChatMessages] = useState<
    { id: string; player_id: string; display_name: string; text: string }[]
  >([]);
  const [chatInput, setChatInput] = useState('');
  const [isVaultVisible, setIsVaultVisible] = useState(false);


  
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
      if (res.data?.status === 'playing') {
        if (pollRef.current) clearInterval(pollRef.current);
        router.push(`/room/${roomId}/game`);
      }
    } catch (error: any) {
      console.error('Failed to fetch room:', error);
    } finally {
      setLoading(false);
    }
  }, [roomId, router]);

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

      if (wsManager.state === 'disconnected' || wsManager.state === 'idle') {
        wsManager.connect(roomId).catch((err) => {
          console.log('[WS] Auto-reconnect failed:', err);
        });
      }
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

  // Connect WebSocket and listen for events
  useEffect(() => {
    if (!roomId) return;

    if (wsManager.state !== 'connected' && wsManager.state !== 'connecting') {
      wsManager.connect(roomId).catch((err) => {
        console.error('[WS] Lobby connect error:', err);
      });
    }

    wsManager.onEvent('round_start', () => {
      if (pollRef.current) clearInterval(pollRef.current);
      router.push(`/room/${roomId}/game`);
    });

    wsManager.onEvent('chat', (data: any) => {
      setChatMessages((prev) => [
        ...prev,
        {
          id: data.id || `${Date.now()}-${Math.random()}`,
          player_id: data.player_id,
          display_name: data.display_name,
          text: data.text,
        },
      ]);
    });

    return () => {
      wsManager.removeEvent('round_start');
      wsManager.removeEvent('chat');
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

    const urls = trimmed.split(/[\n,\s;]+/).map(u => u.trim()).filter(Boolean);
    if (urls.length === 0) {
      toast.info('Paste a video URL first.');
      return;
    }

    setSubmitting(true);
    let addedCount = 0;
    let duplicateCount = 0;
    let failCount = 0;

    for (const singleUrl of urls) {
      try {
        const res = await api.post(`/rooms/${roomId}/reels`, {
          source_url: singleUrl,
        });

        if (res.data?.status === 'already_added') {
          duplicateCount++;
        } else {
          setAddedReels((prev) => [
            ...prev,
            { reel_id: res.data.reel_id, source_url: singleUrl },
          ]);
          addedCount++;
        }

        if (removeFromClipboardOnSuccess) {
          await removeFromClipboard(singleUrl);
        }
      } catch (error: any) {
        failCount++;
        console.error(`Failed to add ${singleUrl}:`, error);
      }
    }

    if (removeFromClipboardOnSuccess) {
      await loadLocalClipboard();
    }
    setReelUrl('');
    fetchRoom();
    setSubmitting(false);

    if (addedCount > 0) {
      toast.success(`Successfully added ${addedCount} video(s)!`);
    }
    if (duplicateCount > 0) {
      toast.info(`${duplicateCount} video(s) were already in the pool.`);
    }
    if (failCount > 0) {
      toast.error(`Failed to add ${failCount} video(s).`);
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
        toast.error(extractErrorMessage(error.response?.data?.detail) || 'Failed to remove Reel');
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
      const errorMsg = extractErrorMessage(error.response?.data?.detail) || 'Failed to start game';
      setStartError(errorMsg);
      toast.error(errorMsg);
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

  const handleSendChat = useCallback(() => {
    const text = chatInput.trim();
    if (!text) return;
    try {
      wsManager.send({
        type: 'chat',
        text: text,
      });
      setChatInput('');
    } catch (err) {
      toast.error('Failed to send message');
    }
  }, [chatInput, toast]);


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
  const minRequired = Math.ceil(selectedRounds / 2);
  const canStartGame = connectedPlayers.every(
    (p) => (room.vault_counts?.[p.id] ?? 0) >= minRequired
  );

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

        {/* Pool Status Card */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pool Status ({minRequired} reels per player)</Text>
          <View style={styles.poolCard}>
            <Text style={styles.poolTotalText}>
              Total Reels in Pool: <Text style={styles.poolTotalValue}>{Object.values(room.vault_counts || {}).reduce((a, b) => a + b, 0)}</Text>
            </Text>
            <View style={styles.poolPlayerList}>
              {connectedPlayers.map((p) => {
                const count = room.vault_counts?.[p.id] ?? 0;
                const met = count >= minRequired;
                return (
                  <View key={p.id} style={styles.poolPlayerRow}>
                    <Text style={styles.poolPlayerName} numberOfLines={1}>{p.display_name}</Text>
                    <View style={[styles.poolBadge, met ? styles.poolBadgeMet : styles.poolBadgeUnder]}>
                      <Text style={[styles.poolBadgeText, met ? styles.poolBadgeTextMet : styles.poolBadgeTextUnder]}>
                        {count} / {minRequired}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
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

          <TouchableOpacity
            style={styles.vaultButton}
            onPress={() => setIsVaultVisible(true)}
            activeOpacity={0.7}
          >
            <Text style={styles.vaultButtonText}>📂 Kasadan Seç (Choose from Vault)</Text>
          </TouchableOpacity>

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

        {/* Lobby Chat Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Lobby Chat</Text>
          <View style={styles.chatContainer}>
            <View style={styles.chatMessagesList}>
              {chatMessages.length === 0 ? (
                <Text style={styles.emptyChatText}>No messages yet. Say hello!</Text>
              ) : (
                chatMessages.slice(-15).map((msg) => (
                  <View key={msg.id} style={styles.chatMessageItem}>
                    <Text style={styles.chatSender}>{msg.display_name}: </Text>
                    <Text style={styles.chatText}>{msg.text}</Text>
                  </View>
                ))
              )}
            </View>
            <View style={styles.chatInputRow}>
              <TextInput
                style={styles.chatInput}
                placeholder="Type a message (max 50 chars)..."
                placeholderTextColor="#555"
                value={chatInput}
                onChangeText={(text) => setChatInput(text.slice(0, 50))}
                maxLength={50}
              />
              <Text style={styles.chatCounter}>{chatInput.length}/50</Text>
              <TouchableOpacity
                style={[styles.chatSendButton, !chatInput.trim() && styles.chatSendButtonDisabled]}
                onPress={handleSendChat}
                disabled={!chatInput.trim()}
              >
                <Text style={styles.chatSendButtonText}>Send</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </ScrollView>

      {/* Actions (pinned to bottom) */}
      <View style={styles.actions}>
        {isHost ? (
          <View style={styles.hostSettings}>
            <Text style={styles.sectionTitle}>Round Count</Text>
            <View style={styles.roundOptions}>
              {[10, 20, 30, 50, 100].map((rounds) => {
                const req = Math.ceil(rounds / 2);
                return (
                  <TouchableOpacity
                    key={rounds}
                    style={[styles.roundButton, selectedRounds === rounds && styles.roundButtonActive]}
                    onPress={() => setSelectedRounds(rounds)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.roundButtonText, selectedRounds === rounds && styles.roundButtonTextActive]}>
                      {rounds} (min {req})
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {!!startError && (
              <Text style={{ color: '#E1306C', fontSize: 14, marginBottom: 8 }}>
                {startError}
              </Text>
            )}
            <TouchableOpacity
              style={[styles.startButton, !canStartGame && styles.startButtonDisabled]}
              onPress={handleStartGame}
              disabled={!canStartGame}
              activeOpacity={0.8}
            >
              <Text style={styles.startButtonText}>
                {canStartGame ? 'Start Game' : `Need ${minRequired} reels per player`}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.hostSettings}>
            <Text style={styles.sectionTitle}>Game Info</Text>
            <Text style={{ color: '#aaa', fontSize: 14, marginBottom: 8 }}>
              Waiting for host to start the game. Selected rounds: {room.round_count} (needs {Math.ceil(room.round_count / 2)} reels per player).
            </Text>
          </View>
        )}

        <TouchableOpacity style={styles.leaveButton} onPress={handleLeave} activeOpacity={0.8}>
          <Text style={styles.leaveButtonText}>Leave Room</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={isVaultVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setIsVaultVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Kasadan Seç (Choose from Vault)</Text>
              <TouchableOpacity onPress={() => setIsVaultVisible(false)}>
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalScroll}>
              {clipboardItems.length === 0 ? (
                <Text style={styles.modalEmpty}>Kasanız boş. Instagram veya TikTok'tan video paylaşarak buraya ekleyebilirsiniz.</Text>
              ) : (
                <View style={styles.modalList}>
                  {clipboardItems.map((item) => {
                    const isTiktok = item.url.toLowerCase().includes('tiktok.com');
                    return (
                      <View key={item.url} style={styles.modalItem}>
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
                            style={styles.modalAddBtn}
                            onPress={async () => {
                              await addVideoToRoom(item.url, true);
                            }}
                            disabled={submitting}
                          >
                            <Text style={styles.clipAddText}>Ekle</Text>
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
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
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
  poolCard: {
    backgroundColor: '#16161F',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2A2A3A',
  },
  poolTotalText: {
    color: '#aaa',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  poolTotalValue: {
    color: '#fff',
    fontWeight: '800',
  },
  poolPlayerList: {
    gap: 8,
  },
  poolPlayerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  poolPlayerName: {
    color: '#fff',
    fontSize: 14,
    flex: 1,
    marginRight: 8,
  },
  poolBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    minWidth: 50,
    alignItems: 'center',
  },
  poolBadgeMet: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
  },
  poolBadgeUnder: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
  },
  poolBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  poolBadgeTextMet: {
    color: '#10B981',
  },
  poolBadgeTextUnder: {
    color: '#EF4444',
  },
  startButtonDisabled: {
    backgroundColor: '#1C1C28',
    opacity: 0.6,
  },
  chatContainer: {
    backgroundColor: '#16161F',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A3A',
    overflow: 'hidden',
  },
  chatMessagesList: {
    padding: 12,
    maxHeight: 180,
    minHeight: 80,
  },
  chatMessageItem: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 6,
  },
  chatSender: {
    color: '#405DE6',
    fontWeight: '700',
    fontSize: 13,
  },
  chatText: {
    color: '#eee',
    fontSize: 13,
  },
  emptyChatText: {
    color: '#555',
    fontSize: 13,
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 20,
  },
  chatInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#2A2A3A',
    backgroundColor: '#0E0E16',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chatInput: {
    flex: 1,
    height: 38,
    color: '#fff',
    fontSize: 13,
    paddingRight: 40,
  },
  chatCounter: {
    color: '#555',
    fontSize: 11,
    position: 'absolute',
    right: 70,
  },
  chatSendButton: {
    backgroundColor: '#405DE6',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  chatSendButtonDisabled: {
    backgroundColor: '#1C1C28',
    opacity: 0.5,
  },
  chatSendButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  vaultButton: {
    marginTop: 10,
    backgroundColor: '#7C3AED',
    borderRadius: 12,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  vaultButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: '#16161F',
    borderRadius: 20,
    width: '100%',
    maxWidth: 500,
    maxHeight: '80%',
    borderWidth: 1,
    borderColor: '#2A2A3A',
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A3A',
  },
  modalTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  modalCloseText: {
    color: '#eee',
    fontSize: 18,
    fontWeight: '700',
    padding: 4,
  },
  modalScroll: {
    padding: 16,
  },
  modalEmpty: {
    color: '#888',
    textAlign: 'center',
    paddingVertical: 32,
    fontSize: 14,
    lineHeight: 20,
  },
  modalList: {
    gap: 10,
    paddingBottom: 20,
  },
  modalItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0E0E16',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#2A2A3A',
    marginBottom: 8,
  },
  modalAddBtn: {
    backgroundColor: '#10B981',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

