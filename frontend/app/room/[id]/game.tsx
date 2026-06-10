import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Animated,
  Dimensions,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import api from '../../../lib/api';
import wsManager from '../../../lib/websocket';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

type PlayerOption = {
  id: string;
  name: string;
};

type RoundData = {
  round_no: number;
  reel_id: string;
  reel_url?: string;
  options: PlayerOption[];
  round_duration_ms: number;
  round_ends_at: string;
};

/** Extract embed URL from a reel or TikTok source URL. */
function getEmbedUrl(sourceUrl?: string): string | null {
  if (!sourceUrl) return null;

  const urlLower = sourceUrl.toLowerCase();

  // Instagram
  if (urlLower.includes('instagram.com')) {
    const match = sourceUrl.match(/\/(reel|reels|p)\/([A-Za-z0-9_-]+)/);
    if (!match) return null;
    const shortcode = match[2];
    return `https://www.instagram.com/reel/${shortcode}/embed/`;
  }

  // TikTok
  if (urlLower.includes('tiktok.com')) {
    const videoIdMatch = sourceUrl.match(/video\/(\d+)/);
    if (videoIdMatch) {
      return `https://www.tiktok.com/embed/v2/${videoIdMatch[1]}`;
    }
  }

  return null;
}

type RoundResult = {
  round_no: number;
  owner_id: string;
  scores: Record<string, number>;
};

type GamePhase = 'playing' | 'result' | 'disconnected';

export default function GameScreen() {
  const { id: roomId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [phase, setPhase] = useState<GamePhase>('playing');
  const [round, setRound] = useState<RoundData | null>(null);
  const [result, setResult] = useState<RoundResult | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [answered, setAnswered] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  const [totalScore, setTotalScore] = useState(0);
  const [lastRoundScore, setLastRoundScore] = useState(0);
  const [wasLastCorrect, setWasLastCorrect] = useState(false);

  // Animation values
  const countdownAnim = useRef(new Animated.Value(1)).current;
  const scorePopAnim = useRef(new Animated.Value(0)).current;

  // Timer refs
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const roundStartTimeRef = useRef<number>(0);

  // Send heartbeat and cleanup timer on unmount
  useEffect(() => {
    const hb = setInterval(() => {
      api.post(`/rooms/${roomId}/heartbeat`).catch(() => {});
    }, 5000);
    return () => {
      clearInterval(hb);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [roomId]);

  // Ensure WebSocket is connected on mount
  useEffect(() => {
    if (!roomId) return;

    if (wsManager.state !== 'connected' && wsManager.state !== 'connecting') {
      wsManager.connect(roomId).catch((err) => {
        console.error('[WS] Game screen connect error:', err);
      });
    }
  }, [roomId]);


  // Start countdown when round data arrives and "renders"
  const startCountdown = useCallback((durationMs: number, endsAtStr?: string) => {
    const endsAt = endsAtStr ? new Date(endsAtStr).getTime() : null;
    const now = Date.now();
    
    let initialTimeLeft = durationMs;
    if (endsAt && endsAt > now) {
      initialTimeLeft = Math.max(0, endsAt - now);
    }
    
    roundStartTimeRef.current = Date.now();
    setTimeLeft(initialTimeLeft);

    // Reset animation
    countdownAnim.setValue(initialTimeLeft / durationMs);
    Animated.timing(countdownAnim, {
      toValue: 0,
      duration: initialTimeLeft,
      useNativeDriver: false,
    }).start();

    // Tick every 100ms for smooth countdown
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - roundStartTimeRef.current;
      const remaining = Math.max(0, initialTimeLeft - elapsed);
      setTimeLeft(remaining);

      if (remaining <= 0) {
        if (timerRef.current) clearInterval(timerRef.current);
      }
    }, 100);
  }, [countdownAnim]);

  // WebSocket event handlers
  useEffect(() => {
    // If the event fired before this screen mounted, use it
    if (wsManager.lastRoundStart && !round) {
      const data = wsManager.lastRoundStart;
      setRound(data);
      setResult(null);
      setChosenId(null);
      setAnswered(false);
      setLastRoundScore(0);
      setWasLastCorrect(false);
      setPhase('playing');
      
      requestAnimationFrame(() => {
        startCountdown(data.round_duration_ms, data.round_ends_at);
      });
    }

    wsManager.onEvent('round_start', (data: any) => {
      setRound(data);
      setResult(null);
      setChosenId(null);
      setAnswered(false);
      setLastRoundScore(0);
      setWasLastCorrect(false);
      setPhase('playing');

      // Start countdown when the reel renders (this callback fires after render commit)
      requestAnimationFrame(() => {
        startCountdown(data.round_duration_ms, data.round_ends_at);
      });
    });

    wsManager.onEvent('round_result', (data: any) => {
      if (timerRef.current) clearInterval(timerRef.current);
      setResult(data);
      setPhase('result');

      // Animate score pop-in
      scorePopAnim.setValue(0);
      Animated.spring(scorePopAnim, {
        toValue: 1,
        tension: 100,
        friction: 8,
        useNativeDriver: true,
      }).start();
    });

    wsManager.onEvent('game_end', () => {
      if (timerRef.current) clearInterval(timerRef.current);
      // Navigate to results after a brief pause
      setTimeout(() => {
        router.replace(`/room/${roomId}/results`);
      }, 1500);
    });

    // Detect disconnection — policy (a): drop is final
    wsManager.onEvent('ws_close', () => {
      if (timerRef.current) clearInterval(timerRef.current);
      setPhase('disconnected');
    });

    return () => {
      wsManager.removeEvent('round_start');
      wsManager.removeEvent('round_result');
      wsManager.removeEvent('game_end');
      wsManager.removeEvent('ws_close');
    };
  }, [roomId, router, startCountdown, scorePopAnim]);

  const handleAnswer = useCallback(async (playerId: string) => {
    if (answered || !round || phase !== 'playing') return;

    setChosenId(playerId);
    setAnswered(true);

    // Elapsed = time since reel rendered, not since WS arrived
    const elapsedMs = Date.now() - roundStartTimeRef.current;

    try {
      const res = await api.post(
        `/rooms/${roomId}/rounds/${round.round_no}/answer`,
        {
          chosen_player_id: playerId,
          elapsed_ms: Math.round(elapsedMs),
        }
      );

      const score = res.data.score ?? 0;
      const correct = res.data.is_correct ?? false;
      setLastRoundScore(score);
      setWasLastCorrect(correct);
      if (correct) {
        setTotalScore((s) => s + score);
      }
    } catch (error: any) {
      console.error('Answer error:', error.response?.data?.detail);
      setLastRoundScore(0);
      setWasLastCorrect(false);
    }
  }, [answered, round, phase, roomId]);

  // Format time
  const formatTime = (ms: number) => {
    const seconds = Math.ceil(ms / 1000);
    return seconds.toString();
  };

  // Disconnected state
  if (phase === 'disconnected') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.disconnectEmoji}>📡</Text>
          <Text style={styles.disconnectTitle}>Disconnected</Text>
          <Text style={styles.disconnectSub}>
            You've been disconnected from the game.
          </Text>
          <TouchableOpacity
            style={styles.homeButton}
            onPress={() => router.replace('/')}
            activeOpacity={0.8}
          >
            <Text style={styles.homeButtonText}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Waiting for first round
  if (!round) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.waitingText}>Starting game...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Result phase
  if (phase === 'result' && result) {
    const correctPlayer = round.options.find((p) => p.id === result.owner_id);

    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.resultContainer}>
          <Text style={styles.roundLabel}>Round {round.round_no}</Text>

          <Animated.View
            style={[
              styles.resultCard,
              {
                transform: [{ scale: scorePopAnim }],
                opacity: scorePopAnim,
              },
            ]}
          >
            <Text style={styles.resultEmoji}>{wasLastCorrect ? '✅' : '❌'}</Text>
            <Text style={styles.resultTitle}>
              {wasLastCorrect ? 'Correct!' : 'Wrong!'}
            </Text>
            <Text style={styles.resultOwner}>
              Shared by: {correctPlayer?.name ?? 'Unknown'}
            </Text>
            <Text style={styles.resultScore}>
              +{lastRoundScore} points
            </Text>
          </Animated.View>

          <Text style={styles.totalScore}>Total: {totalScore}</Text>
          <Text style={styles.waitingNext}>Next round starting...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Playing phase
  const countdownWidth = countdownAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  const timeColor = timeLeft < 3000 ? '#E1306C' : '#405DE6';

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.roundLabel}>Round {round.round_no}</Text>
        <Text style={[styles.timer, { color: timeColor }]}>
          {formatTime(timeLeft)}
        </Text>
      </View>

      {/* Countdown Bar */}
      <View style={styles.countdownBar}>
        <Animated.View
          style={[
            styles.countdownFill,
            { width: countdownWidth, backgroundColor: timeColor },
          ]}
        />
      </View>

      {/* Reel Display */}
      <View style={styles.reelContainer}>
        <Text style={styles.reelQuestion}>
          Who shared this {round.reel_url?.toLowerCase().includes('tiktok.com') ? 'TikTok' : 'Reel'}?
        </Text>
        {Platform.OS === 'web' && getEmbedUrl(round.reel_url) ? (
          <View style={styles.embedWrapper}>
            <iframe
              src={getEmbedUrl(round.reel_url)!}
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                borderRadius: 12,
                background: '#111',
              }}
              scrolling="no"
              allowTransparency
              allow="encrypted-media"
            />
          </View>
        ) : (
          <View style={styles.reelFallback}>
            <Text style={styles.reelEmoji}>🎬</Text>
            <Text style={styles.reelId}>
              {round.reel_url?.toLowerCase().includes('tiktok.com') ? 'TikTok' : 'Reel'}: {round.reel_id.slice(0, 8)}...
            </Text>
          </View>
        )}
      </View>

      {/* Player Options */}
      <View style={styles.optionsContainer}>
        {round.options.map((player) => {
          const isChosen = chosenId === player.id;
          return (
            <TouchableOpacity
              key={player.id}
              style={[
                styles.optionButton,
                isChosen && styles.optionChosen,
                answered && !isChosen && styles.optionDisabled,
              ]}
              onPress={() => handleAnswer(player.id)}
              disabled={answered}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.optionText,
                  isChosen && styles.optionTextChosen,
                ]}
              >
                {player.name}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Score */}
      <View style={styles.footer}>
        <Text style={styles.totalScore}>Score: {totalScore}</Text>
        {answered && (
          <Text style={styles.waitingResult}>Waiting for others...</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0F',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  roundLabel: {
    color: '#888',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  timer: {
    fontSize: 36,
    fontWeight: '900',
  },
  countdownBar: {
    height: 4,
    backgroundColor: '#1A1A24',
    marginHorizontal: 24,
    marginTop: 12,
    borderRadius: 2,
    overflow: 'hidden',
  },
  countdownFill: {
    height: '100%',
    borderRadius: 2,
  },
  reelContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  embedWrapper: {
    width: Math.min(SCREEN_WIDTH - 32, 400),
    height: 480,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#111',
    marginTop: 8,
  },
  reelFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  reelEmoji: {
    fontSize: 64,
    marginBottom: 16,
  },
  reelQuestion: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
  },
  reelId: {
    color: '#555',
    fontSize: 12,
    marginTop: 8,
  },
  optionsContainer: {
    paddingHorizontal: 24,
    gap: 10,
  },
  optionButton: {
    height: 56,
    backgroundColor: '#16161F',
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#2A2A3A',
  },
  optionChosen: {
    borderColor: '#405DE6',
    backgroundColor: '#1A1A30',
  },
  optionDisabled: {
    opacity: 0.4,
  },
  optionText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  optionTextChosen: {
    color: '#405DE6',
  },
  footer: {
    padding: 24,
    alignItems: 'center',
  },
  totalScore: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  waitingResult: {
    color: '#888',
    fontSize: 13,
    marginTop: 8,
  },
  waitingText: {
    color: '#888',
    fontSize: 18,
  },
  // Result phase
  resultContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  resultCard: {
    alignItems: 'center',
    backgroundColor: '#16161F',
    borderRadius: 24,
    padding: 32,
    width: SCREEN_WIDTH - 48,
    borderWidth: 1,
    borderColor: '#2A2A3A',
    marginVertical: 24,
  },
  resultEmoji: {
    fontSize: 56,
    marginBottom: 12,
  },
  resultTitle: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '900',
  },
  resultOwner: {
    color: '#888',
    fontSize: 16,
    marginTop: 8,
  },
  resultScore: {
    color: '#405DE6',
    fontSize: 24,
    fontWeight: '800',
    marginTop: 12,
  },
  waitingNext: {
    color: '#555',
    fontSize: 14,
    marginTop: 16,
  },
  // Disconnected
  disconnectEmoji: {
    fontSize: 56,
    marginBottom: 16,
  },
  disconnectTitle: {
    color: '#E1306C',
    fontSize: 28,
    fontWeight: '900',
    marginBottom: 8,
  },
  disconnectSub: {
    color: '#888',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 32,
  },
  homeButton: {
    backgroundColor: '#405DE6',
    height: 48,
    paddingHorizontal: 32,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  homeButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
