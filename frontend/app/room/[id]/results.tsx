import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import api from '../../../lib/api';
import { clearSession } from '../../../lib/session';
import wsManager from '../../../lib/websocket';

type LeaderboardEntry = {
  player_id: string;
  display_name: string;
  total_score: number;
  correct_count: number;
  avg_reaction_ms: number;
};

type MatchReport = {
  room_id: string;
  leaderboard: LeaderboardEntry[];
  streaks?: Record<string, any>;
  averages?: Record<string, any>;
};

export default function ResultsScreen() {
  const { id: roomId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [report, setReport] = useState<MatchReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'score' | 'speed' | 'accuracy'>('score');
  const [playAgainLoading, setPlayAgainLoading] = useState(false);

  // Animated values for name dancing
  const anim1 = useRef(new Animated.Value(0)).current;
  const anim2 = useRef(new Animated.Value(0)).current;
  const anim3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const fetchReport = async () => {
      try {
        const res = await api.get(`/rooms/${roomId}/report`);
        setReport(res.data);
      } catch (err: any) {
        setError(err.response?.data?.detail || 'Failed to load report');
      } finally {
        setLoading(false);
      }
    };

    fetchReport();

    // Disconnect WebSocket if still connected
    wsManager.disconnect();
  }, [roomId]);

  useEffect(() => {
    // Dancing animations (bobbing up and down)
    const createDance = (anim: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, {
            toValue: -6,
            duration: 1100,
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: 0,
            duration: 1100,
            useNativeDriver: true,
          }),
        ])
      );
    };

    const dance1 = createDance(anim1, 0);
    const dance2 = createDance(anim2, 350);
    const dance3 = createDance(anim3, 700);

    dance1.start();
    dance2.start();
    dance3.start();

    return () => {
      dance1.stop();
      dance2.stop();
      dance3.stop();
    };
  }, [anim1, anim2, anim3]);

  const handlePlayAgain = async () => {
    setPlayAgainLoading(true);
    try {
      await api.post(`/rooms/${roomId}/play-again`);
      router.replace(`/room/${roomId}`);
    } catch (err: any) {
      // Fallback in case it fails or someone else reset it
      router.replace(`/room/${roomId}`);
    } finally {
      setPlayAgainLoading(false);
    }
  };

  const handleLeaveGame = async () => {
    try {
      await api.delete(`/rooms/${roomId}/leave`);
    } catch (err) {}
    await clearSession();
    router.replace('/');
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#E1306C" />
          <Text style={styles.loadingText}>Loading results...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error || !report) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.errorText}>{error || 'No report available'}</Text>
          <TouchableOpacity style={styles.homeButton} onPress={handleLeaveGame}>
            <Text style={styles.homeButtonText}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const leaderboard = report.leaderboard || [];

  // Sort based on active tab
  const sorted = [...leaderboard];
  if (activeTab === 'score') {
    sorted.sort((a, b) => b.total_score - a.total_score);
  } else if (activeTab === 'speed') {
    sorted.sort((a, b) => {
      const timeA = a.avg_reaction_ms !== undefined ? a.avg_reaction_ms : 999999;
      const timeB = b.avg_reaction_ms !== undefined ? b.avg_reaction_ms : 999999;
      return timeA - timeB;
    });
  } else if (activeTab === 'accuracy') {
    sorted.sort((a, b) => b.correct_count - a.correct_count);
  }

  const p1 = sorted[0];
  const p2 = sorted[1];
  const p3 = sorted[2];

  const getDisplayVal = (entry: LeaderboardEntry | undefined) => {
    if (!entry) return '-';
    if (activeTab === 'score') {
      return `${entry.total_score} pts`;
    }
    if (activeTab === 'speed') {
      return entry.avg_reaction_ms !== undefined && entry.avg_reaction_ms > 0
        ? `${(entry.avg_reaction_ms / 1000).toFixed(2)}s`
        : '--';
    }
    if (activeTab === 'accuracy') {
      return `${entry.correct_count} correct`;
    }
    return '-';
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Title */}
      <View style={styles.header}>
        <Text style={styles.trophy}>🏆</Text>
        <Text style={styles.title}>Final Leaderboard</Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabsContainer}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'score' && styles.tabButtonActive]}
          onPress={() => setActiveTab('score')}
        >
          <Text style={[styles.tabButtonText, activeTab === 'score' && styles.tabButtonTextActive]}>
            Puan Sıralaması
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'speed' && styles.tabButtonActive]}
          onPress={() => setActiveTab('speed')}
        >
          <Text style={[styles.tabButtonText, activeTab === 'speed' && styles.tabButtonTextActive]}>
            En Hızlı
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'accuracy' && styles.tabButtonActive]}
          onPress={() => setActiveTab('accuracy')}
        >
          <Text style={[styles.tabButtonText, activeTab === 'accuracy' && styles.tabButtonTextActive]}>
            En İsabetli
          </Text>
        </TouchableOpacity>
      </View>

      {/* Podium Display */}
      <View style={styles.podiumContainer}>
        {/* 2nd Place */}
        <View style={[styles.podiumColumn, { opacity: p2 ? 1 : 0.3 }]}>
          <View style={styles.podiumAvatarContainer}>
            <View style={styles.podiumAvatar}>
              <Text style={styles.podiumAvatarText}>
                {p2 ? p2.display_name.charAt(0).toUpperCase() : '?'}
              </Text>
            </View>
            <Animated.Text
              style={[
                styles.podiumName,
                { transform: [{ translateY: anim2 }] },
              ]}
              numberOfLines={1}
            >
              {p2 ? p2.display_name : '-'}
            </Animated.Text>
          </View>
          <View style={[styles.podiumStep, styles.podiumStep2]}>
            <Text style={styles.podiumRank}>2</Text>
            <Text style={styles.podiumValue} numberOfLines={2}>
              {getDisplayVal(p2)}
            </Text>
          </View>
        </View>

        {/* 1st Place */}
        <View style={[styles.podiumColumn, { opacity: p1 ? 1 : 0.3 }]}>
          <View style={styles.podiumAvatarContainer}>
            {p1 && <Text style={styles.podiumCrown}>👑</Text>}
            <View style={[styles.podiumAvatar, styles.podiumAvatar1]}>
              <Text style={[styles.podiumAvatarText, styles.podiumAvatarText1]}>
                {p1 ? p1.display_name.charAt(0).toUpperCase() : '?'}
              </Text>
            </View>
            <Animated.Text
              style={[
                styles.podiumName,
                { transform: [{ translateY: anim1 }], fontWeight: '800' },
              ]}
              numberOfLines={1}
            >
              {p1 ? p1.display_name : '-'}
            </Animated.Text>
          </View>
          <View style={[styles.podiumStep, styles.podiumStep1]}>
            <Text style={styles.podiumRank}>1</Text>
            <Text style={styles.podiumValue} numberOfLines={2}>
              {getDisplayVal(p1)}
            </Text>
          </View>
        </View>

        {/* 3rd Place */}
        <View style={[styles.podiumColumn, { opacity: p3 ? 1 : 0.3 }]}>
          <View style={styles.podiumAvatarContainer}>
            <View style={styles.podiumAvatar}>
              <Text style={styles.podiumAvatarText}>
                {p3 ? p3.display_name.charAt(0).toUpperCase() : '?'}
              </Text>
            </View>
            <Animated.Text
              style={[
                styles.podiumName,
                { transform: [{ translateY: anim3 }] },
              ]}
              numberOfLines={1}
            >
              {p3 ? p3.display_name : '-'}
            </Animated.Text>
          </View>
          <View style={[styles.podiumStep, styles.podiumStep3]}>
            <Text style={styles.podiumRank}>3</Text>
            <Text style={styles.podiumValue} numberOfLines={2}>
              {getDisplayVal(p3)}
            </Text>
          </View>
        </View>
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.playAgainButton}
          onPress={handlePlayAgain}
          activeOpacity={0.8}
          disabled={playAgainLoading}
        >
          <Text style={styles.playAgainText}>
            {playAgainLoading ? 'Resetting Room...' : 'Play Again'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.leaveButton}
          onPress={handleLeaveGame}
          activeOpacity={0.8}
        >
          <Text style={styles.leaveText}>Leave Game</Text>
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
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  loadingText: {
    color: '#888',
    fontSize: 16,
    marginTop: 16,
  },
  errorText: {
    color: '#E1306C',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 24,
  },
  header: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  trophy: {
    fontSize: 48,
    marginBottom: 8,
  },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '900',
  },
  tabsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 20,
  },
  tabButton: {
    backgroundColor: '#16161F',
    borderWidth: 1,
    borderColor: '#2A2A3A',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 8,
    flex: 1,
    alignItems: 'center',
  },
  tabButtonActive: {
    backgroundColor: '#7C3AED',
    borderColor: '#7C3AED',
  },
  tabButtonText: {
    color: '#888899',
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  tabButtonTextActive: {
    color: '#fff',
  },
  podiumContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-end',
    height: 300,
    paddingHorizontal: 16,
    marginVertical: 16,
    flex: 1,
  },
  podiumColumn: {
    flex: 1,
    alignItems: 'center',
    maxWidth: 110,
  },
  podiumAvatarContainer: {
    alignItems: 'center',
    marginBottom: 10,
    position: 'relative',
    width: '100%',
  },
  podiumAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#405DE6',
    borderWidth: 2,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
    elevation: 6,
  },
  podiumAvatar1: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderColor: '#F59E0B',
  },
  podiumAvatarText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 18,
  },
  podiumAvatarText1: {
    fontSize: 22,
  },
  podiumCrown: {
    fontSize: 22,
    position: 'absolute',
    top: -20,
    zIndex: 10,
  },
  podiumName: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
    textAlign: 'center',
  },
  podiumStep: {
    width: '100%',
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 5,
  },
  podiumStep1: {
    height: 160,
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.4)',
  },
  podiumStep2: {
    height: 120,
    backgroundColor: 'rgba(148, 163, 184, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.4)',
  },
  podiumStep3: {
    height: 85,
    backgroundColor: 'rgba(180, 83, 9, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(180, 83, 9, 0.4)',
  },
  podiumRank: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '900',
  },
  podiumValue: {
    color: '#eee',
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center',
  },
  actions: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    gap: 12,
  },
  playAgainButton: {
    height: 50,
    backgroundColor: '#7C3AED',
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#7C3AED',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  playAgainText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  leaveButton: {
    height: 50,
    backgroundColor: '#16161F',
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A3A',
  },
  leaveText: {
    color: '#888899',
    fontSize: 16,
    fontWeight: '700',
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
