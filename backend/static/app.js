// WhoSharedThisVideo? — Pure JS Web Client (improved)
// Same backend API contract as before; client-side improvements only.

// -----------------------------------------------------------------------------
// State Configuration
// -----------------------------------------------------------------------------
const state = {
  token: null,
  roomId: null,
  playerId: null,
  roomData: null,
  isHost: false,
  pollInterval: null,
  heartbeatInterval: null,
  ws: null,
  wsConnected: false,
  selectedRounds: 20,
  answered: false,
  timerInterval: null,
  timerMsLeft: 0,
  totalTimerMs: 15000, // standard round duration
  currentRoundNo: null,
  myChosenId: null,
  userSelectedRoundsManually: false,
  lang: 'en', // default, will auto-detect
  soundEnabled: true,
  streak: 0,
  lastTickSecond: 0,
};

// -----------------------------------------------------------------------------
// i18n — full English / Turkish dictionaries
// -----------------------------------------------------------------------------
const I18N = {
  en: {
    tagline: 'Guess who sent this reel — fast!',
    howTo: "Everyone adds reels they've saved, then you guess whose taste is whose. Best with 3+ friends.",
    nicknameLabel: 'Nickname',
    nicknamePlaceholder: 'Enter your name...',
    or: 'OR',
    roomCodeLabel: 'Room code (to join)',
    roomCodePlaceholder: '6-digit code (e.g. 123456)',
    createRoom: 'Create room',
    joinRoom: 'Join room',
    roomCodeUpper: 'ROOM CODE',
    tapToCopy: 'tap code to copy',
    shareInvite: '🔗 Invite link',
    leave: 'Leave',
    players: 'Players',
    poolStatus: 'Pool status',
    reqPerPlayer: '{n} reels per player',
    totalReels: 'Total reels in pool:',
    myReelsInPool: 'My reels in pool',
    noReelsYet: "You haven't added any reels to this room yet.",
    addVideos: 'Add videos',
    urlPlaceholder: 'Instagram, TikTok or YouTube Shorts URL...',
    myVaultBtn: '🎬 My reels',
    lobbyChat: 'Lobby chat',
    noMessages: 'No messages yet. Say hello!',
    chatPlaceholder: 'Type a message...',
    send: 'Send',
    hostControls: 'Host controls',
    roundCount: 'Round count',
    roundHint: 'Each round needs a reel — players must add at least half the round count each.',
    startGame: 'Start game',
    needReels: 'Need {n} reels per player',
    gameInfo: 'Game info',
    waitingHost: 'Waiting for the host to start the game...',
    waitingInfo: 'Waiting for the host. Selected rounds: {rounds} (requires {req} reels per player).',
    roundUpper: 'ROUND',
    timeLeftUpper: 'TIME LEFT',
    roundTitle: 'Round {a} / {b}',
    whoShared: 'Who shared this video?',
    guessSubmitted: 'Guess locked in!',
    waitingRoundEnd: 'Waiting for the round to end...',
    roundResults: 'Round results',
    sharedBy: 'Shared by:',
    correct: 'Correct! 🎉',
    incorrect: 'Incorrect ❌',
    earnedPoints: 'You earned <strong>+{n}</strong> points',
    streakLabel: '{n} in a row!',
    nextRound: 'Next round starts in a few seconds...',
    finalLeaderboard: 'Final leaderboard',
    matchResults: 'Match results',
    tabScore: 'Top score',
    tabSpeed: 'Fastest guesser',
    tabAccuracy: 'Most accurate',
    playAgain: 'Play again',
    leaveGame: 'Leave game',
    vaultTitle: '🎬 My reels',
    vaultExplainer: 'Saved on this device — collect videos here and add them to any room.',
    vaultEmpty: 'Your collection is empty. Paste a URL above to start saving videos.',
    notePlaceholder: 'Add a note...',
    addToVault: 'Save to my reels',
    addBtn: 'Add',
    savedToVault: 'Saved to your reels!',
    noteSaved: 'Note saved.',
    removedFromVault: 'Removed from your reels.',
    embedFail: "This platform doesn't allow embedding here.",
    openInNewTab: 'Open video in a new tab',
    openVideo: 'Open video',
    videoId: 'Video ID: {id}...',
    // toasts / prompts
    enterName: 'Please enter a display name first.',
    codeSixDigits: 'Room codes are exactly 6 digits.',
    roomCreated: 'Room created!',
    roomJoined: 'Joined room!',
    createFailed: 'Failed to create room.',
    joinFailed: 'Failed to join room.',
    resuming: 'Resuming your session...',
    readyToJoin: 'Ready to join room {code}!',
    leftRoom: 'Left the room.',
    leaveConfirm: 'Leave the room?',
    codeCopied: 'Room code {code} copied!',
    copyFailed: 'Could not copy. Long-press the code instead.',
    inviteCopied: 'Invite link copied — send it to your friends!',
    enterUrlFirst: 'Paste a video URL first.',
    addedCount: 'Added {n} video(s)!',
    dupCount: '{n} video(s) were already in the pool.',
    failCount: 'Could not add {n} video(s). Check the URLs.',
    alreadyInPool: 'This video is already in the room pool.',
    addedToRoom: 'Video added to the room pool!',
    addFailed: 'Failed to add video.',
    removePoolConfirm: 'Remove this video from the room pool?',
    removedFromPool: 'Removed from the room pool.',
    removeFailed: 'Failed to remove the video.',
    chatTooLong: 'Messages must be 50 characters or less.',
    chatOffline: 'Chat is reconnecting, try again in a second.',
    chatSendFailed: 'Failed to send message.',
    startFailed: 'Failed to start the game.',
    answerFailed: 'Failed to submit your guess — try again.',
    reportFailed: 'Failed to load the final results.',
    roomReset: 'Room reset for a new match!',
    restartFailed: 'Failed to restart the game.',
    soundOn: 'Sound on',
    soundOff: 'Sound off',
  },
  tr: {
    tagline: 'Bu reeli kim attı, hızlıca tahmin et!',
    howTo: 'Herkes kaydettiği reelleri ekler, sonra hangisi kimin zevki tahmin edersiniz. 3+ arkadaşla en eğlencelisi.',
    nicknameLabel: 'Takma ad',
    nicknamePlaceholder: 'Adını yaz...',
    or: 'VEYA',
    roomCodeLabel: 'Oda kodu (katılmak için)',
    roomCodePlaceholder: '6 haneli kod (örn. 123456)',
    createRoom: 'Oda kur',
    joinRoom: 'Odaya katıl',
    roomCodeUpper: 'ODA KODU',
    tapToCopy: 'kopyalamak için koda dokunun',
    shareInvite: '🔗 Davet linki',
    leave: 'Ayrıl',
    players: 'Oyuncular',
    poolStatus: 'Havuz durumu',
    reqPerPlayer: 'Oyuncu başı {n} video',
    totalReels: 'Havuzdaki toplam video:',
    myReelsInPool: 'Havuzdaki videolarım',
    noReelsYet: 'Bu odaya henüz video eklemediniz.',
    addVideos: 'Video ekle',
    urlPlaceholder: 'Instagram, TikTok veya YouTube Shorts linki...',
    myVaultBtn: '🎬 Videolarım',
    lobbyChat: 'Lobby sohbeti',
    noMessages: 'Henüz mesaj yok. Selam ver!',
    chatPlaceholder: 'Bir mesaj yaz...',
    send: 'Gönder',
    hostControls: 'Yönetici ayarları',
    roundCount: 'Tur sayısı',
    roundHint: 'Her tur için bir video gerekir — oyuncuların tur sayısının en az yarısı kadar video eklemesi gerekir.',
    startGame: 'Oyunu başlat',
    needReels: 'Oyuncu başı {n} video gerekiyor',
    gameInfo: 'Oyun bilgisi',
    waitingHost: 'Yöneticinin oyunu başlatması bekleniyor...',
    waitingInfo: 'Yönetici bekleniyor. Seçilen tur: {rounds} (oyuncu başı en az {req} video gerekir).',
    roundUpper: 'TUR',
    timeLeftUpper: 'KALAN SÜRE',
    roundTitle: 'Tur {a} / {b}',
    whoShared: 'Bu videoyu kim paylaştı?',
    guessSubmitted: 'Tahmin kilitlendi!',
    waitingRoundEnd: 'Turun bitmesi bekleniyor...',
    roundResults: 'Tur sonuçları',
    sharedBy: 'Paylaşan:',
    correct: 'Doğru! 🎉',
    incorrect: 'Yanlış ❌',
    earnedPoints: '<strong>+{n}</strong> puan kazandınız',
    streakLabel: 'Üst üste {n}!',
    nextRound: 'Sonraki tur birkaç saniye içinde başlıyor...',
    finalLeaderboard: 'Final liderlik tablosu',
    matchResults: 'Maç sonuçları',
    tabScore: 'En yüksek puan',
    tabSpeed: 'En hızlı tahminci',
    tabAccuracy: 'En isabetli',
    playAgain: 'Tekrar oyna',
    leaveGame: 'Oyundan ayrıl',
    vaultTitle: '🎬 Videolarım',
    vaultExplainer: 'Bu cihaza kaydedildi — videoları burada biriktirip herhangi bir odaya ekleyebilirsiniz.',
    vaultEmpty: 'Koleksiyonunuz boş. Video kaydetmeye başlamak için yukarıya bir link yapıştırın.',
    notePlaceholder: 'Not ekle...',
    addToVault: 'Videolarıma kaydet',
    addBtn: 'Ekle',
    savedToVault: 'Videolarınıza kaydedildi!',
    noteSaved: 'Not kaydedildi.',
    removedFromVault: 'Videolarınızdan kaldırıldı.',
    embedFail: 'Bu platform doğrudan gösterime izin vermiyor.',
    openInNewTab: 'Videoyu yeni sekmede aç',
    openVideo: 'Videoyu aç',
    videoId: 'Video ID: {id}...',
    // toasts / prompts
    enterName: 'Lütfen önce bir kullanıcı adı belirleyin.',
    codeSixDigits: 'Oda kodları tam 6 haneli olmalıdır.',
    roomCreated: 'Oda oluşturuldu!',
    roomJoined: 'Odaya giriş yapıldı!',
    createFailed: 'Oda oluşturulamadı.',
    joinFailed: 'Odaya katılım sağlanamadı.',
    resuming: 'Oturum geri yükleniyor...',
    readyToJoin: "Oda {code}'a katılmaya hazır!",
    leftRoom: 'Odadan ayrıldınız.',
    leaveConfirm: 'Odadan ayrılmak istediğinize emin misiniz?',
    codeCopied: 'Oda kodu {code} kopyalandı!',
    copyFailed: 'Kopyalanamadı. Lütfen kod üzerine uzun basın.',
    inviteCopied: 'Davet linki kopyalandı — arkadaşlarınıza gönderin!',
    enterUrlFirst: 'Önce bir video linki yapıştırın.',
    addedCount: '{n} adet video başarıyla eklendi!',
    dupCount: '{n} adet video havuzda zaten var.',
    failCount: '{n} adet video eklenemedi. Linkleri kontrol edin.',
    alreadyInPool: 'Bu video oda havuzunda zaten bulunuyor.',
    addedToRoom: 'Video oda havuzuna eklendi!',
    addFailed: 'Video ekleme başarısız.',
    removePoolConfirm: 'Bu videoyu oda havuzundan kaldırmak istediğinize emin misiniz?',
    removedFromPool: 'Video oda havuzundan kaldırıldı.',
    removeFailed: 'Video kaldırma başarısız.',
    chatTooLong: 'Mesajlar en fazla 50 karakter olmalıdır.',
    chatOffline: 'Sohbet bağlantısı kuruluyor, tekrar deneyin.',
    chatSendFailed: 'Mesaj gönderilemedi.',
    startFailed: 'Oyun başlatılamadı.',
    answerFailed: 'Tahmin gönderilemedi — tekrar deneyin.',
    reportFailed: 'Final sonuçları yüklenemedi.',
    roomReset: 'Oda yeni bir maç için sıfırlandı!',
    restartFailed: 'Oyun yeniden başlatılamadı.',
    soundOn: 'Ses açık',
    soundOff: 'Ses kapalı',
  }
};

// -----------------------------------------------------------------------------
// Web Audio API Synthesized Sounds
// -----------------------------------------------------------------------------
let audioCtx = null;

function playSound(type) {
  if (!state.soundEnabled) return;
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    
    const now = audioCtx.currentTime;
    
    if (type === 'correct') {
      // High pitch ding: C5 (523.25 Hz) then E5 (659.25 Hz)
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(659.25, now + 0.1);
      
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
      
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.45);
      
    } else if (type === 'incorrect') {
      // Low buzz: 150 Hz down to 80 Hz sawtooth
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.exponentialRampToValueAtTime(80, now + 0.3);
      
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.35);
      
    } else if (type === 'tick') {
      // Short high-frequency click
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, now);
      
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
      
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.05);
      
    } else if (type === 'click') {
      // Low interface click
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(300, now);
      
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.06);
      
    } else if (type === 'win') {
      // Chord fanfare: C4, E4, G4, C5 arpeggio
      const notes = [261.63, 329.63, 392.00, 523.25];
      notes.forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);
        
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.06, now + idx * 0.08 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.08 + 0.4);
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.4);
      });
    }
  } catch (e) {
    console.warn('Web Audio play failed:', e);
  }
}

// -----------------------------------------------------------------------------
// Canvas Confetti Engine
// -----------------------------------------------------------------------------
let confettiActive = false;
let confettiParticles = [];
const confettiColors = ['#E1306C', '#7C3AED', '#405DE6', '#10B981', '#F59E0B', '#EF4444'];

function startConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  canvas.style.display = 'block';
  confettiActive = true;
  confettiParticles = [];
  
  resizeConfettiCanvas();
  window.addEventListener('resize', resizeConfettiCanvas);
  
  for (let i = 0; i < 150; i++) {
    confettiParticles.push(createConfettiParticle(canvas.width, canvas.height, true));
  }
  
  requestAnimationFrame(updateConfetti);
  playSound('win');
}

function stopConfetti() {
  confettiActive = false;
  const canvas = document.getElementById('confetti-canvas');
  if (canvas) {
    canvas.style.display = 'none';
  }
  window.removeEventListener('resize', resizeConfettiCanvas);
}

function resizeConfettiCanvas() {
  const canvas = document.getElementById('confetti-canvas');
  if (canvas) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
}

function createConfettiParticle(width, height, isStart = false) {
  return {
    x: Math.random() * width,
    y: isStart ? Math.random() * -height : -20,
    size: Math.random() * 8 + 6,
    color: confettiColors[Math.floor(Math.random() * confettiColors.length)],
    speedX: Math.random() * 4 - 2,
    speedY: Math.random() * 5 + 3,
    rotation: Math.random() * 360,
    rotationSpeed: Math.random() * 4 - 2
  };
}

function updateConfetti() {
  if (!confettiActive) return;
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  for (let i = 0; i < confettiParticles.length; i++) {
    const p = confettiParticles[i];
    p.y += p.speedY;
    p.x += p.speedX;
    p.rotation += p.rotationSpeed;
    
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((p.rotation * Math.PI) / 180);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
    ctx.restore();
    
    if (p.y > canvas.height) {
      confettiParticles[i] = createConfettiParticle(canvas.width, canvas.height);
    }
  }
  
  requestAnimationFrame(updateConfetti);
}

// -----------------------------------------------------------------------------
// Avatar HSL Color Generator
// -----------------------------------------------------------------------------
function getAvatarColor(name) {
  if (!name) return 'var(--secondary-accent)';
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 42%)`;
}

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Load settings and language
  const savedLang = localStorage.getItem('ws_game_lang');
  if (savedLang === 'en' || savedLang === 'tr') {
    state.lang = savedLang;
  } else {
    // Auto detect browser language
    const isTurkish = navigator.language?.toLowerCase().startsWith('tr') ||
                     navigator.languages?.some(l => l.toLowerCase().startsWith('tr'));
    state.lang = isTurkish ? 'tr' : 'en';
  }

  const savedSound = localStorage.getItem('ws_game_sound');
  state.soundEnabled = savedSound !== 'false';
  
  const soundBtn = document.getElementById('sound-toggle-btn');
  if (soundBtn) {
    soundBtn.textContent = state.soundEnabled ? '🔊' : '🔇';
  }

  initApp();
  setupEventListeners();
  translatePage();
});

// -----------------------------------------------------------------------------
// App Setup
// -----------------------------------------------------------------------------
async function initApp() {
  state.token = sessionStorage.getItem('ws_session_token');
  state.roomId = sessionStorage.getItem('ws_room_id');
  state.playerId = sessionStorage.getItem('ws_player_id');

  if (state.token && state.roomId && state.playerId) {
    showToast('resuming', 'info');
    enterLobby();
  } else {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) {
      document.getElementById('room-code-input').value = code.trim().replace(/[^0-9]/g, '');
      showToast('readyToJoin', 'info', { code });
    }
    showView('welcome-view');
  }
}

// -----------------------------------------------------------------------------
// Event Listeners
// -----------------------------------------------------------------------------
function setupEventListeners() {
  // Welcome View
  document.getElementById('create-room-btn').addEventListener('click', handleCreateRoom);
  document.getElementById('join-room-btn').addEventListener('click', handleJoinRoom);
  
  document.getElementById('room-code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/[^0-9]/g, '');
  });

  // Enter keys for Welcome inputs
  document.getElementById('nickname-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const code = document.getElementById('room-code-input').value.trim();
      if (code.length === 6) {
        handleJoinRoom();
      } else {
        document.getElementById('room-code-input').focus();
      }
      playSound('click');
    }
  });
  document.getElementById('room-code-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleJoinRoom();
      playSound('click');
    }
  });

  // Lobby View
  document.getElementById('room-code-display').addEventListener('click', copyRoomCode);
  document.getElementById('leave-lobby-btn').addEventListener('click', handleLeaveRoom);
  document.getElementById('add-reel-btn').addEventListener('click', handleAddReelManual);
  document.getElementById('open-vault-btn').addEventListener('click', openVaultModal);
  document.getElementById('send-chat-btn').addEventListener('click', handleSendChat);
  document.getElementById('chat-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSendChat();
  });
  document.getElementById('chat-input').addEventListener('input', updateChatCounter);

  // Invite friends and share invite link
  document.getElementById('share-invite-btn').addEventListener('click', () => {
    const code = state.roomData?.code || '';
    if (!code) return;
    const inviteUrl = `${window.location.origin}/?code=${code}`;
    playSound('click');
    if (navigator.share) {
      navigator.share({
        title: 'WhoSharedThisVideo?',
        text: `Join room ${code} to play WhoSharedThisVideo!`,
        url: inviteUrl
      }).catch(() => {
        copyToClipboard(inviteUrl);
      });
    } else {
      copyToClipboard(inviteUrl);
    }
  });

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('inviteCopied', 'success');
    }).catch(() => {
      showToast('copyFailed', 'error');
    });
  }

  // Add Reel keyboard Enter key
  document.getElementById('reel-url-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleAddReelManual();
      playSound('click');
    }
  });

  // Host Control Selectors
  document.querySelectorAll('.btn-round').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const rounds = parseInt(e.target.dataset.rounds, 10);
      setRoundCount(rounds);
      playSound('click');
    });
  });
  document.getElementById('start-game-btn').addEventListener('click', handleStartGame);

  // Leaderboard View
  document.getElementById('leaderboard-leave-btn').addEventListener('click', handleLeaveRoom);
  document.getElementById('leaderboard-playagain-btn').addEventListener('click', handlePlayAgainFromLeaderboard);

  // Modal Controls
  document.getElementById('close-vault-modal').addEventListener('click', closeVaultModal);
  document.getElementById('vault-modal').addEventListener('click', (e) => {
    if (e.target.id === 'vault-modal') closeVaultModal();
  });
  document.getElementById('modal-vault-add-btn').addEventListener('click', handleAddReelToVault);

  // Keyboard Enter keys for vault inputs
  document.getElementById('modal-vault-url-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleAddReelToVault();
      playSound('click');
    }
  });
  document.getElementById('modal-vault-note-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleAddReelToVault();
      playSound('click');
    }
  });

  // Event Delegation for Vault modal item list actions (add / delete)
  document.getElementById('vault-modal-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const action = btn.dataset.action;
    const url = btn.dataset.url;
    if (action === 'add') {
      addFromVaultToRoom(url);
      playSound('click');
    } else if (action === 'delete') {
      deleteFromVault(url);
      playSound('click');
    }
  });

  // Podium Tab Switchers
  document.querySelectorAll('.podium-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.podium-tab-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      activePodiumTab = e.target.dataset.tab;
      renderLeaderboard(currentLeaderboardData);
      playSound('click');
    });
  });

  // Top utility bar (lang & sound toggles)
  document.getElementById('lang-toggle-btn').addEventListener('click', () => {
    state.lang = state.lang === 'en' ? 'tr' : 'en';
    localStorage.setItem('ws_game_lang', state.lang);
    translatePage();
    playSound('click');
  });

  document.getElementById('sound-toggle-btn').addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem('ws_game_sound', state.soundEnabled ? 'true' : 'false');
    const soundBtn = document.getElementById('sound-toggle-btn');
    if (soundBtn) {
      soundBtn.textContent = state.soundEnabled ? '🔊' : '🔇';
    }
    playSound('click');
  });
}

// -----------------------------------------------------------------------------
// Translation Engine
// -----------------------------------------------------------------------------
function translatePage() {
  const lang = state.lang;
  const dict = I18N[lang] || I18N['en'];
  
  // Update data-i18n elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (dict[key]) {
      if (el.id === 'requirement-count' && state.roomData) {
        const minRequired = Math.ceil(state.selectedRounds / 2);
        el.textContent = dict.reqPerPlayer.replace('{n}', minRequired);
      } else if (el.id === 'waiting-game-info' && state.roomData) {
        const rounds = state.roomData.round_count || state.selectedRounds;
        el.textContent = dict.waitingInfo
          .replace('{rounds}', rounds)
          .replace('{req}', Math.ceil(rounds / 2));
      } else {
        el.innerHTML = dict[key];
      }
    }
  });
  
  // Update placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    if (dict[key]) {
      el.placeholder = dict[key];
    }
  });

  // Update active Lang indicator
  const langBtn = document.getElementById('lang-toggle-btn');
  if (langBtn) {
    langBtn.textContent = lang.toUpperCase();
  }
}

// -----------------------------------------------------------------------------
// Session Management
// -----------------------------------------------------------------------------
function saveSession(token, roomId, playerId) {
  state.token = token;
  state.roomId = roomId;
  state.playerId = playerId;
  sessionStorage.setItem('ws_session_token', token);
  sessionStorage.setItem('ws_room_id', roomId);
  sessionStorage.setItem('ws_player_id', playerId);
}

function clearSession() {
  state.token = null;
  state.roomId = null;
  state.playerId = null;
  state.roomData = null;
  state.isHost = false;
  state.streak = 0;
  sessionStorage.removeItem('ws_session_token');
  sessionStorage.removeItem('ws_room_id');
  sessionStorage.removeItem('ws_player_id');
  
  if (state.pollInterval) {
    clearInterval(state.pollInterval);
    state.pollInterval = null;
  }
  if (state.heartbeatInterval) {
    clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = null;
  }
  
  disconnectWebSocket();
  stopConfetti();

  const chatMessagesEl = document.getElementById('chat-messages');
  if (chatMessagesEl) {
    const dict = I18N[state.lang] || I18N['en'];
    chatMessagesEl.innerHTML = `<div class="empty-chat">${dict.noMessages || 'No messages yet.'}</div>`;
  }
}

// -----------------------------------------------------------------------------
// View Switching
// -----------------------------------------------------------------------------
function showView(viewId) {
  document.querySelectorAll('.view').forEach(view => {
    view.classList.remove('active');
  });
  const activeView = document.getElementById(viewId);
  if (activeView) {
    activeView.classList.add('active');
  }
}

// -----------------------------------------------------------------------------
// API Request Wrappers
// -----------------------------------------------------------------------------
async function apiCall(endpoint, options = {}) {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  const url = cleanEndpoint.startsWith('api/v1') ? `/${cleanEndpoint}` : `/api/v1/${cleanEndpoint}`;
  
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }
  
  const config = {
    method: 'GET',
    ...options,
    headers
  };
  
  try {
    const res = await fetch(url, config);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw { response: { data: errData } };
    }
    return await res.json();
  } catch (error) {
    console.error(`API Error on ${url}:`, error);
    throw error;
  }
}

function extractErrorMessage(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((err) => {
        if (err && typeof err === 'object') {
          const field = err.loc ? err.loc.filter(l => l !== 'body').join('.') : '';
          const msg = err.msg || 'Validation error';
          return field ? `${field}: ${msg}` : msg;
        }
        return String(err);
      })
      .join(', ');
  }
  if (typeof detail === 'object') {
    return detail.message || detail.detail || JSON.stringify(detail);
  }
  return String(detail);
}

// -----------------------------------------------------------------------------
// Welcome View Logic
// -----------------------------------------------------------------------------
async function handleCreateRoom() {
  const name = document.getElementById('nickname-input').value.trim();
  if (!name) {
    showToast('enterName', 'warning');
    return;
  }
  
  try {
    const res = await apiCall('/rooms', {
      method: 'POST',
      body: JSON.stringify({
        display_name: name,
        max_players: 8
      })
    });
    
    saveSession(res.session_token, res.room_id, res.player_id);
    showToast('roomCreated', 'success');
    enterLobby();
  } catch (err) {
    const detail = err.response?.data?.detail;
    showToast(extractErrorMessage(detail) || 'createFailed', 'error');
  }
}

async function handleJoinRoom() {
  const name = document.getElementById('nickname-input').value.trim();
  const code = document.getElementById('room-code-input').value.trim().replace(/[^0-9]/g, '');
  
  if (!name) {
    showToast('enterName', 'warning');
    return;
  }
  if (code.length !== 6) {
    showToast('codeSixDigits', 'warning');
    return;
  }
  
  try {
    const res = await apiCall('/rooms/join', {
      method: 'POST',
      body: JSON.stringify({
        room_code: code,
        display_name: name
      })
    });
    
    saveSession(res.session_token, res.room_id, res.player_id);
    showToast('roomJoined', 'success');
    enterLobby();
  } catch (err) {
    const detail = err.response?.data?.detail;
    showToast(extractErrorMessage(detail) || 'joinFailed', 'error');
  }
}

// -----------------------------------------------------------------------------
// Lobby View Logic
// -----------------------------------------------------------------------------
function enterLobby() {
  const chatMessagesEl = document.getElementById('chat-messages');
  if (chatMessagesEl) {
    const dict = I18N[state.lang] || I18N['en'];
    chatMessagesEl.innerHTML = `<div class="empty-chat">${dict.noMessages || 'No messages yet. Say hello!'}</div>`;
  }

  showView('lobby-view');
  fetchRoom();
  connectWebSocket();
  stopConfetti();
  
  if (state.pollInterval) clearInterval(state.pollInterval);
  state.pollInterval = setInterval(() => {
    fetchRoom();
  }, 3000);

  if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
  state.heartbeatInterval = setInterval(() => {
    if (state.roomId && state.playerId) {
      apiCall(`/rooms/${state.roomId}/heartbeat`, { method: 'POST' }).catch(() => {});
      
      if (!state.wsConnected) {
        console.log('[WS] Connection idle, auto-reconnecting...');
        connectWebSocket();
      }
    }
  }, 3000);
}

async function fetchRoom() {
  if (!state.roomId) return;
  try {
    const res = await apiCall(`/rooms/${state.roomId}`);
    state.roomData = res;
    
    document.getElementById('room-code-display').textContent = res.code;
    
    const me = res.players.find(p => p.id === state.playerId);
    state.isHost = me ? me.is_host : false;
    
    if (res.status === 'playing') {
      if (state.pollInterval) {
        clearInterval(state.pollInterval);
        state.pollInterval = null;
      }
      showView('game-view');
      enterGame();
      return;
    }

    if (res.status === 'finished') {
      if (state.pollInterval) {
        clearInterval(state.pollInterval);
        state.pollInterval = null;
      }
      showView('leaderboard-view');
      fetchLeaderboardReport();
      return;
    }
    
    renderLobbyPlayers(res.players, me);
    renderPoolStatus(res.players, res.vault_counts || {});
    fetchMyVaultReels();

    const totalReels = Object.values(res.vault_counts || {}).reduce((a, b) => a + b, 0);
    const activePlayers = res.players.filter(p => p.is_connected);
    const playerCount = activePlayers.length;
    const defaultRounds = playerCount > 0 ? Math.floor(totalReels / playerCount) + (playerCount * 2) : 20;

    if (!state.userSelectedRoundsManually) {
      state.selectedRounds = defaultRounds;
    }

    document.querySelectorAll('.btn-round').forEach(btn => {
      if (parseInt(btn.dataset.rounds, 10) === state.selectedRounds) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    updateHostControls(me);
    translatePage();
    
  } catch (err) {
    console.error('Failed to fetch room state:', err);
  }
}

function renderLobbyPlayers(players, me) {
  const container = document.getElementById('player-list');
  const countEl = document.getElementById('player-count');
  
  const activePlayers = players.filter(p => p.is_connected);
  countEl.textContent = `${activePlayers.length}/${state.roomData.max_players}`;
  
  container.innerHTML = activePlayers.map(player => `
    <div class="player-row">
      <div class="player-avatar" style="background: ${getAvatarColor(player.display_name)};">${player.display_name.charAt(0).toUpperCase()}</div>
      <div class="player-name">${escapeHtml(player.display_name)}</div>
      ${player.is_host ? '<span class="badge badge-host">HOST</span>' : ''}
      ${player.id === state.playerId ? '<span class="badge badge-you">YOU</span>' : ''}
    </div>
  `).join('');
}

function renderPoolStatus(players, vaultCounts) {
  const minRequired = Math.ceil(state.selectedRounds / 2);
  const dict = I18N[state.lang] || I18N['en'];
  
  document.getElementById('requirement-count').textContent = dict.reqPerPlayer ? dict.reqPerPlayer.replace('{n}', minRequired) : `${minRequired} reels per player`;
  
  const activePlayers = players.filter(p => p.is_connected);
  const totalReels = Object.values(vaultCounts).reduce((a, b) => a + b, 0);
  document.getElementById('pool-total').textContent = totalReels;
  
  const container = document.getElementById('pool-player-list');
  container.innerHTML = activePlayers.map(p => {
    const count = vaultCounts[p.id] || 0;
    const met = count >= minRequired;
    const badgeClass = met ? 'pool-badge-met' : 'pool-badge-under';
    const statusIcon = met ? '✅' : '⏳';
    
    return `
      <div class="pool-player-row">
        <div class="pool-player-name">${escapeHtml(p.display_name)}</div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span>${statusIcon}</span>
          <div class="pool-badge ${badgeClass}">${count} / ${minRequired}</div>
        </div>
      </div>
    `;
  }).join('');
}

function updateHostControls(me) {
  const hostCard = document.getElementById('host-settings-card');
  const waitingCard = document.getElementById('player-waiting-card');
  const dict = I18N[state.lang] || I18N['en'];
  
  if (state.isHost) {
    hostCard.classList.remove('hidden');
    waitingCard.classList.add('hidden');
    
    const minRequired = Math.ceil(state.selectedRounds / 2);
    const activePlayers = state.roomData.players.filter(p => p.is_connected);
    const allMet = activePlayers.every(p => (state.roomData.vault_counts?.[p.id] ?? 0) >= minRequired);
    
    const startBtn = document.getElementById('start-game-btn');
    if (allMet) {
      startBtn.disabled = false;
      startBtn.textContent = dict.startGame || 'Start Game';
      document.getElementById('start-error-msg').classList.add('hidden');
    } else {
      startBtn.disabled = true;
      startBtn.textContent = dict.needReels ? dict.needReels.replace('{n}', minRequired) : `Need ${minRequired} reels per player`;
    }
  } else {
    hostCard.classList.add('hidden');
    waitingCard.classList.remove('hidden');
    
    const rounds = state.roomData.round_count;
    document.getElementById('waiting-game-info').textContent = dict.waitingInfo
      ? dict.waitingInfo.replace('{rounds}', rounds).replace('{req}', Math.ceil(rounds / 2))
      : `Waiting for host to start the game. Selected rounds: ${rounds} (requires ${Math.ceil(rounds / 2)} reels per player).`;
  }
}

function setRoundCount(rounds) {
  state.selectedRounds = rounds;
  state.userSelectedRoundsManually = true;
  document.querySelectorAll('.btn-round').forEach(btn => {
    if (parseInt(btn.dataset.rounds, 10) === rounds) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  fetchRoom();
}

async function handleStartGame() {
  document.getElementById('start-error-msg').classList.add('hidden');
  try {
    await apiCall(`/rooms/${state.roomId}/start`, {
      method: 'POST',
      body: JSON.stringify({
        round_count: state.selectedRounds
      })
    });
  } catch (err) {
    const detail = err.response?.data?.detail;
    const msg = extractErrorMessage(detail) || 'Failed to start game.';
    const errEl = document.getElementById('start-error-msg');
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
    showToast('startFailed', 'error');
  }
}

async function handleLeaveRoom() {
  const dict = I18N[state.lang] || I18N['en'];
  if (!confirm(dict.leaveConfirm || 'Leave the room?')) return;
  try {
    await apiCall(`/rooms/${state.roomId}/leave`, { method: 'DELETE' });
  } catch (err) {
    // ignore
  } finally {
    clearSession();
    showToast('leftRoom', 'info');
    showView('welcome-view');
    translatePage();
  }
}

function copyRoomCode() {
  const code = document.getElementById('room-code-display').textContent;
  if (!code || code === '------') return;
  navigator.clipboard.writeText(code).then(() => {
    showToast('codeCopied', 'success', { code });
  }).catch(() => {
    showToast('copyFailed', 'error');
  });
}

// -----------------------------------------------------------------------------
// Reel Ingestion Logic (Lobby)
// -----------------------------------------------------------------------------
async function handleAddReelManual() {
  const input = document.getElementById('reel-url-input');
  const url = input.value.trim();
  if (!url) {
    showToast('enterUrlFirst', 'warning');
    return;
  }
  
  const urls = url.split(/[\n,\s;]+/).map(u => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    showToast('enterUrlFirst', 'warning');
    return;
  }
  
  let successCount = 0;
  let dupCount = 0;
  let failCount = 0;
  
  for (const singleUrl of urls) {
    try {
      const res = await apiCall(`/rooms/${state.roomId}/reels`, {
        method: 'POST',
        body: JSON.stringify({ source_url: singleUrl })
      });
      
      if (res?.status === 'already_added') {
        dupCount++;
      } else {
        successCount++;
        saveToLocalVault(singleUrl);
      }
    } catch (err) {
      failCount++;
    }
  }
  
  input.value = '';
  fetchRoom();
  
  if (successCount > 0) showToast('addedCount', 'success', { n: successCount });
  if (dupCount > 0) showToast('dupCount', 'info', { n: dupCount });
  if (failCount > 0) showToast('failCount', 'error', { n: failCount });
}

// -----------------------------------------------------------------------------
// Local Storage Vault Integration
// -----------------------------------------------------------------------------
const VAULT_STORAGE_KEY = '@reel_game_clipboard_urls';

function getLocalVault() {
  try {
    const raw = localStorage.getItem(VAULT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToLocalVault(url, note = '') {
  try {
    const current = getLocalVault();
    const normalized = url.trim();
    if (current.some(item => item.url.toLowerCase() === normalized.toLowerCase())) {
      return;
    }
    const updated = [{ url: normalized, addedAt: Date.now(), note: note }, ...current];
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(updated));
  } catch (e) {
    console.error('Failed to write local vault:', e);
  }
}

function removeFromLocalVault(url) {
  try {
    const current = getLocalVault();
    const normalized = url.trim().toLowerCase();
    const updated = current.filter(item => item.url.trim().toLowerCase() !== normalized);
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(updated));
  } catch (e) {
    console.error('Failed to remove from local vault:', e);
  }
}

// -----------------------------------------------------------------------------
// Vault Modal view
// -----------------------------------------------------------------------------
function openVaultModal() {
  const modal = document.getElementById('vault-modal');
  modal.classList.remove('hidden');
  renderVaultModalList();
}

function closeVaultModal() {
  document.getElementById('vault-modal').classList.add('hidden');
}

function renderVaultModalList() {
  const vaultItems = getLocalVault();
  const listEl = document.getElementById('vault-modal-list');
  const dict = I18N[state.lang] || I18N['en'];
  
  if (vaultItems.length === 0) {
    listEl.innerHTML = `<div class="empty-text">${dict.vaultEmpty || 'Your collection is empty.'}</div>`;
    return;
  }
  
  listEl.innerHTML = vaultItems.map(item => {
    const isTiktok = item.url.toLowerCase().includes('tiktok.com');
    const label = isTiktok ? 'TikTok' : item.url.toLowerCase().includes('instagram.com') ? 'Insta' : 'Link';
    const tagClass = isTiktok ? 'tiktok' : 'insta';
    const displayUrl = reelShortcode(item.url);
    const note = item.note || '';
    
    return `
      <div class="vault-item" style="flex-direction: column; align-items: stretch; gap: 8px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span class="vault-item-tag ${tagClass}">${label}</span>
          <span class="vault-item-url" title="${escapeHtml(item.url)}" style="font-weight: bold; max-width: 180px;">${escapeHtml(displayUrl)}</span>
          <div class="vault-actions">
            <button class="btn btn-primary btn-sm" data-action="add" data-url="${escapeHtml(item.url)}">${dict.addBtn || 'Add'}</button>
            <button class="btn btn-danger btn-sm" data-action="delete" data-url="${escapeHtml(item.url)}">✕</button>
          </div>
        </div>
        <div>
          <input type="text" class="vault-item-note-input" placeholder="${dict.notePlaceholder || 'Add a note...'}" value="${escapeHtml(note)}" onchange="updateVaultItemNote('${escapeJsString(item.url)}', this.value)">
        </div>
      </div>
    `;
  }).join('');
}

async function addFromVaultToRoom(url) {
  try {
    const res = await apiCall(`/rooms/${state.roomId}/reels`, {
      method: 'POST',
      body: JSON.stringify({ source_url: url })
    });
    
    if (res?.status === 'already_added') {
      showToast('alreadyInPool', 'info');
    } else {
      showToast('addedToRoom', 'success');
    }
  } catch (err) {
    showToast('addFailed', 'error');
  } finally {
    renderVaultModalList();
    fetchRoom();
  }
}

function deleteFromVault(url) {
  removeFromLocalVault(url);
  showToast('removedFromVault', 'info');
  renderVaultModalList();
}

function reelShortcode(url) {
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
}

// -----------------------------------------------------------------------------
// WebSocket Management
// -----------------------------------------------------------------------------
function connectWebSocket() {
  if (state.ws) {
    state.ws.onopen = null;
    state.ws.onmessage = null;
    state.ws.onerror = null;
    state.ws.onclose = null;
    state.ws.close();
  }
  
  if (!state.roomId || !state.token) return;
  
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/api/v1/rooms/${state.roomId}/ws?token=${encodeURIComponent(state.token)}`;
  
  console.log('[WS] Connecting to:', wsUrl);
  const socket = new WebSocket(wsUrl);
  
  socket.onopen = () => {
    console.log('[WS] Connected successfully.');
    state.wsConnected = true;
  };
  
  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsEvent(msg.event, msg);
    } catch (e) {
      console.warn('[WS] Failed to parse message:', event.data);
    }
  };
  
  socket.onerror = (err) => {
    console.error('[WS] Socket error:', err);
    state.wsConnected = false;
  };
  
  socket.onclose = () => {
    console.log('[WS] Connection closed.');
    state.wsConnected = false;
  };
  
  state.ws = socket;
}

function disconnectWebSocket() {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  state.wsConnected = false;
}

function handleWsEvent(event, data) {
  console.log(`[WS Event] ${event}:`, data);
  
  switch (event) {
    case 'round_start':
      if (state.pollInterval) {
        clearInterval(state.pollInterval);
        state.pollInterval = null;
      }
      showView('game-view');
      renderRound(data);
      break;
      
    case 'round_result':
      renderRoundResult(data);
      break;
      
    case 'game_end':
      showView('leaderboard-view');
      fetchLeaderboardReport();
      break;
      
    case 'room_reset':
      state.streak = 0;
      enterLobby();
      break;
      
    case 'chat':
      appendChatMessage(data);
      break;
      
    case 'pool_updated':
      fetchRoom();
      break;
  }
}

// -----------------------------------------------------------------------------
// Chat Logic
// -----------------------------------------------------------------------------
function handleSendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  
  if (text.length > 50) {
    showToast('chatTooLong', 'warning');
    return;
  }
  
  if (!state.wsConnected) {
    showToast('chatOffline', 'error');
    return;
  }
  
  try {
    state.ws.send(JSON.stringify({
      type: 'chat',
      text: text
    }));
    input.value = '';
    updateChatCounter();
  } catch (err) {
    showToast('chatSendFailed', 'error');
  }
}

function appendChatMessage(data) {
  const container = document.getElementById('chat-messages');
  
  const empty = container.querySelector('.empty-chat');
  if (empty) empty.remove();
  
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-message-item';
  msgEl.innerHTML = `
    <span class="chat-msg-sender">${escapeHtml(data.display_name)}:</span>
    <span class="chat-msg-text">${escapeHtml(data.text)}</span>
  `;
  
  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
}

function updateChatCounter() {
  const text = document.getElementById('chat-input').value;
  document.getElementById('chat-char-count').textContent = text.length;
}

// -----------------------------------------------------------------------------
// Live Game view Logic
// -----------------------------------------------------------------------------
function enterGame() {
  state.answered = false;
  state.streak = 0;
  const chip = document.getElementById('streak-chip');
  if (chip) chip.classList.add('hidden');
  document.getElementById('guess-status-box').classList.add('hidden');
}

function getEmbedUrl(sourceUrl) {
  if (!sourceUrl) return null;
  const urlLower = sourceUrl.toLowerCase();
  
  if (urlLower.includes('instagram.com')) {
    const match = sourceUrl.match(/\/(reel|reels|p)\/([A-Za-z0-9_-]+)/);
    if (!match) return null;
    return `https://www.instagram.com/reel/${match[2]}/embed/`;
  }
  
  if (urlLower.includes('tiktok.com')) {
    const match = sourceUrl.match(/video\/(\d+)/);
    if (match) {
      return `https://www.tiktok.com/embed/v2/${match[1]}`;
    }
  }

  if (urlLower.includes('youtube.com/shorts/') || urlLower.includes('youtu.be/')) {
    let videoId = null;
    if (urlLower.includes('youtube.com/shorts/')) {
      const match = sourceUrl.match(/shorts\/([A-Za-z0-9_-]+)/);
      if (match) videoId = match[1];
    } else {
      const match = sourceUrl.match(/youtu\.be\/([A-Za-z0-9_-]+)/);
      if (match) videoId = match[1];
    }
    if (videoId) {
      return `https://www.youtube.com/embed/${videoId}`;
    }
  }
  return null;
}

function renderRound(data) {
  state.answered = data.answered || false;
  state.myChosenId = data.my_chosen_id || null;
  state.currentRoundNo = data.round_no;
  
  const sidebar = document.querySelector('.game-sidebar');
  const dict = I18N[state.lang] || I18N['en'];
  if (sidebar) {
    sidebar.innerHTML = `
      <h3>${dict.whoShared || 'Who shared this video?'}</h3>
      <div id="guess-buttons" class="guess-buttons-grid"></div>
      <div id="guess-status-box" class="guess-status-box hidden"></div>
    `;
  }
  
  const endsAt = data.round_ends_at ? new Date(data.round_ends_at).getTime() : null;
  const now = Date.now();
  state.totalTimerMs = data.round_duration_ms || 15000;
  
  if (endsAt && endsAt > now) {
    state.timerMsLeft = Math.max(0, endsAt - now);
  } else {
    state.timerMsLeft = state.totalTimerMs;
  }
  
  document.getElementById('game-timer').classList.remove('timer-urgent');
  document.getElementById('game-progress-bar').classList.remove('progress-urgent');
  updateTimerProgress();
  
  const total = state.roomData?.round_count ?? 10;
  document.getElementById('game-round-title').textContent = dict.roundTitle 
    ? dict.roundTitle.replace('{a}', data.round_no).replace('{b}', total)
    : `Round ${data.round_no} / ${total}`;
  
  const frame = document.getElementById('reel-embed-frame');
  const fallback = document.getElementById('no-embed-fallback');
  const embedUrl = getEmbedUrl(data.reel_url);
  
  const isTiktok = data.reel_url?.toLowerCase().includes('tiktok.com');
  document.getElementById('media-type-badge').textContent = isTiktok ? 'TIKTOK' : 'INSTAGRAM';
  
  const reelIdText = data.reel_id ? data.reel_id.slice(0, 8) : 'unknown';
  document.getElementById('media-short-text').textContent = dict.videoId
    ? dict.videoId.replace('{id}', reelIdText)
    : `Video ID: ${reelIdText}...`;
  
  const container = document.querySelector('.video-container');
  if (container) {
    if (data.thumbnail_url) {
      container.style.backgroundImage = `url('${data.thumbnail_url}')`;
      container.style.backgroundSize = 'cover';
      container.style.backgroundPosition = 'center';
      
      const fallbackThumb = document.getElementById('fallback-thumb');
      if (fallbackThumb) {
        fallbackThumb.style.backgroundImage = `url('${data.thumbnail_url}')`;
      }
    } else {
      container.style.backgroundImage = 'none';
      const fallbackThumb = document.getElementById('fallback-thumb');
      if (fallbackThumb) {
        fallbackThumb.style.backgroundImage = 'none';
      }
    }
  }

  const directLink = document.getElementById('direct-open-link');
  if (directLink && data.reel_url) {
    directLink.href = data.reel_url;
    directLink.classList.remove('hidden');
  } else if (directLink) {
    directLink.classList.add('hidden');
  }

  if (embedUrl) {
    frame.src = embedUrl;
    frame.classList.remove('hidden');
    fallback.classList.add('hidden');
  } else {
    frame.src = 'about:blank';
    frame.classList.add('hidden');
    fallback.classList.remove('hidden');
    const link = document.getElementById('fallback-link');
    link.href = data.reel_url;
  }
  
  renderGuessButtons(data.options, data.round_no);

  if (state.answered) {
    document.querySelectorAll('.guess-btn').forEach(btn => {
      btn.disabled = true;
      if (btn.dataset.playerId === state.myChosenId) {
        btn.classList.add('guess-selected');
      }
    });
    const statusBox = document.getElementById('guess-status-box');
    statusBox.className = 'guess-status-box submitted';
    statusBox.innerHTML = `
      <div class="guess-status-title">${dict.guessSubmitted || 'Guess locked in!'}</div>
      <div class="guess-status-desc">${dict.waitingRoundEnd || 'Waiting for the round to end...'}</div>
    `;
    statusBox.classList.remove('hidden');
  }
  
  if (state.timerInterval) clearInterval(state.timerInterval);
  const startTick = Date.now();
  const initialMsLeft = state.timerMsLeft;
  state.lastTickSecond = Math.ceil(state.timerMsLeft / 1000);
  
  state.timerInterval = setInterval(() => {
    const elapsed = Date.now() - startTick;
    state.timerMsLeft = Math.max(0, initialMsLeft - elapsed);
    
    const secLeft = Math.ceil(state.timerMsLeft / 1000);
    document.getElementById('game-timer').textContent = `${secLeft}s`;
    updateTimerProgress();
    
    // Timer Urgency
    if (state.timerMsLeft <= 5000 && state.timerMsLeft > 0) {
      document.getElementById('game-timer').classList.add('timer-urgent');
      document.getElementById('game-progress-bar').classList.add('progress-urgent');
      
      if (secLeft !== state.lastTickSecond) {
        state.lastTickSecond = secLeft;
        playSound('tick');
      }
    } else {
      document.getElementById('game-timer').classList.remove('timer-urgent');
      document.getElementById('game-progress-bar').classList.remove('progress-urgent');
    }
    
    if (state.timerMsLeft <= 0) {
      clearInterval(state.timerInterval);
    }
  }, 100);
}

function updateTimerProgress() {
  const percent = (state.timerMsLeft / state.totalTimerMs) * 100;
  document.getElementById('game-progress-bar').style.width = `${percent}%`;
}

function renderGuessButtons(options, roundNo) {
  const container = document.getElementById('guess-buttons');
  document.getElementById('guess-status-box').classList.add('hidden');
  
  if (!options) {
    container.innerHTML = '';
    return;
  }
  
  container.innerHTML = options.map((player, idx) => {
    const letter = String.fromCharCode(65 + idx);
    return `
      <button class="guess-btn" data-player-id="${player.id}" onclick="submitGuess('${player.id}')">
        <span class="guess-btn-letter">${letter}</span>
        ${escapeHtml(player.name)}
      </button>
    `;
  }).join('');
}

async function submitGuess(playerId) {
  if (state.answered) return;
  state.answered = true;
  state.myChosenId = playerId;
  
  document.querySelectorAll('.guess-btn').forEach(btn => {
    btn.disabled = true;
    if (btn.dataset.playerId === playerId) {
      btn.classList.add('guess-selected');
    }
  });
  
  const reactionTime = state.totalTimerMs - state.timerMsLeft;
  
  try {
    await apiCall(`/rooms/${state.roomId}/rounds/${state.currentRoundNo}/answer`, {
      method: 'POST',
      body: JSON.stringify({
        chosen_player_id: playerId,
        elapsed_ms: Math.round(reactionTime)
      })
    });
    
    const dict = I18N[state.lang] || I18N['en'];
    const statusBox = document.getElementById('guess-status-box');
    statusBox.className = 'guess-status-box submitted';
    statusBox.innerHTML = `
      <div class="guess-status-title">${dict.guessSubmitted || 'Guess locked in!'}</div>
      <div class="guess-status-desc">${dict.waitingRoundEnd || 'Waiting for the round to end...'}</div>
    `;
    statusBox.classList.remove('hidden');
    playSound('click');
  } catch (err) {
    showToast('answerFailed', 'error');
    state.answered = false;
    state.myChosenId = null;
    document.querySelectorAll('.guess-btn').forEach(btn => {
      btn.disabled = false;
      btn.classList.remove('guess-selected');
    });
  }
}

function renderRoundResult(data) {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  
  const sidebar = document.querySelector('.game-sidebar');
  if (!sidebar) return;

  const owner = data.leaderboard ? data.leaderboard.find(p => p.player_id === data.owner_id) : null;
  const ownerName = owner ? owner.name : 'Unknown';
  
  const isCorrect = state.myChosenId === data.owner_id;
  const scoreGain = data.scores ? (data.scores[state.playerId] || 0) : 0;
  
  if (isCorrect) {
    playSound('correct');
  } else {
    playSound('incorrect');
  }
  
  const streakChip = document.getElementById('streak-chip');
  const streakCountSpan = document.getElementById('streak-count');
  if (isCorrect) {
    state.streak++;
    if (state.streak >= 2) {
      if (streakChip) streakChip.classList.remove('hidden');
      if (streakCountSpan) streakCountSpan.textContent = state.streak;
    }
  } else {
    state.streak = 0;
    if (streakChip) streakChip.classList.add('hidden');
  }
  
  const dict = I18N[state.lang] || I18N['en'];
  
  const feedbackHtml = `
    <div class="round-feedback-banner ${isCorrect ? 'correct' : 'incorrect'}" style="margin-bottom: 16px; padding: 12px; border-radius: 12px; text-align: center; border: 1px solid var(--border-color); background: ${isCorrect ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)'};">
      <div style="font-size: 16px; font-weight: 800; color: ${isCorrect ? 'var(--success-color)' : 'var(--danger-color)'};">
        ${isCorrect ? (dict.correct || 'Correct! 🎉') : (dict.incorrect || 'Incorrect ❌')}
      </div>
      <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">
        ${dict.earnedPoints ? dict.earnedPoints.replace('{n}', scoreGain) : `You earned <strong>+${scoreGain}</strong> points`}
      </div>
      ${state.streak >= 2 ? `
      <div class="streak-banner">
        ${dict.streakLabel ? dict.streakLabel.replace('{n}', state.streak) : `🔥 ${state.streak} in a row!`}
      </div>` : ''}
    </div>
  `;
  
  const leaderboardHtml = (data.leaderboard || []).map((player, idx) => {
    let rankEmoji = '';
    if (idx === 0) rankEmoji = '👑 ';
    else if (idx === 1) rankEmoji = '🥈 ';
    else if (idx === 2) rankEmoji = '🥉 ';
    
    const guessScore = data.scores ? (data.scores[player.player_id] || 0) : 0;
    const scoreStr = guessScore > 0 ? `+${guessScore}` : '0';
    const scoreClass = guessScore > 0 ? 'score-gain-positive' : 'score-gain-zero';
    
    const isMeClass = player.player_id === state.playerId ? 'leaderboard-me' : '';
    
    return `
      <div class="leaderboard-item-break ${isMeClass}">
        <div class="leaderboard-rank-break">${rankEmoji || (idx + 1)}</div>
        <div class="leaderboard-name-break" style="display: flex; align-items: center; gap: 8px;">
          <div class="player-avatar" style="width: 24px; height: 24px; font-size: 11px; margin-right: 4px; background: ${getAvatarColor(player.name)};">${player.name.charAt(0).toUpperCase()}</div>
          ${escapeHtml(player.name)}
        </div>
        <div class="leaderboard-score-break">
          ${player.score} pts <span class="${scoreClass}">(${scoreStr})</span>
        </div>
      </div>
    `;
  }).join('');
  
  sidebar.innerHTML = `
    <h3 style="margin-bottom: 8px;">${dict.roundResults || 'Round Results'}</h3>
    <div class="round-owner-announcement" style="margin-bottom: 12px; font-size: 15px; color: var(--text-secondary);">
      ${dict.sharedBy || 'Shared by:'} <strong style="color: var(--primary-accent);">${escapeHtml(ownerName)}</strong>
    </div>
    
    ${feedbackHtml}
    
    <div class="leaderboard-break-list">
      ${leaderboardHtml}
    </div>
    <div style="margin-top: 24px; font-size: 12px; color: var(--text-muted); text-align: center; font-style: italic;">
      ${dict.nextRound || 'Next round starting in a few seconds...'}
    </div>
  `;
}

// -----------------------------------------------------------------------------
// Leaderboard View Logic
// -----------------------------------------------------------------------------
let currentLeaderboardData = [];
let activePodiumTab = 'score';

async function fetchLeaderboardReport() {
  try {
    const res = await apiCall(`/rooms/${state.roomId}/report`);
    currentLeaderboardData = res.leaderboard || [];
    renderLeaderboard(currentLeaderboardData);
    startConfetti();
  } catch (err) {
    showToast('reportFailed', 'error');
  }
}

async function handlePlayAgainFromLeaderboard() {
  try {
    await apiCall(`/rooms/${state.roomId}/play-again`, { method: 'POST' });
    stopConfetti();
    enterLobby();
    showToast('roomReset', 'success');
  } catch (err) {
    const detail = err.response?.data?.detail;
    showToast(extractErrorMessage(detail) || 'restartFailed', 'error');
  }
}

async function handleAddReelToVault() {
  const urlInput = document.getElementById('modal-vault-url-input');
  const noteInput = document.getElementById('modal-vault-note-input');
  const url = urlInput.value.trim();
  const note = noteInput.value.trim();
  
  if (!url) {
    showToast('enterUrlFirst', 'warning');
    return;
  }
  
  saveToLocalVault(url, note);
  urlInput.value = '';
  noteInput.value = '';
  showToast('savedToVault', 'success');
  renderVaultModalList();
}

function updateVaultItemNote(url, note) {
  try {
    const current = getLocalVault();
    const normalized = url.trim().toLowerCase();
    const updated = current.map(item => {
      if (item.url.trim().toLowerCase() === normalized) {
        return { ...item, note: note.trim() };
      }
      return item;
    });
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(updated));
    showToast('noteSaved', 'success');
  } catch (e) {
    console.error('Failed to save note:', e);
  }
}

function renderLeaderboard(leaderboard) {
  let sorted = [];
  if (activePodiumTab === 'score') {
    sorted = [...leaderboard].sort((a, b) => b.total_score - a.total_score);
  } else if (activePodiumTab === 'speed') {
    sorted = [...leaderboard].sort((a, b) => {
      const timeA = a.avg_reaction_ms !== undefined ? a.avg_reaction_ms : 999999;
      const timeB = b.avg_reaction_ms !== undefined ? b.avg_reaction_ms : 999999;
      return timeA - timeB;
    });
  } else if (activePodiumTab === 'accuracy') {
    sorted = [...leaderboard].sort((a, b) => b.correct_count - a.correct_count);
  }
  
  const p1 = sorted[0];
  const p2 = sorted[1];
  const p3 = sorted[2];
  
  updatePodiumColumn(1, p1, activePodiumTab);
  updatePodiumColumn(2, p2, activePodiumTab);
  updatePodiumColumn(3, p3, activePodiumTab);
}

function updatePodiumColumn(placeNum, player, tabType) {
  const col = document.getElementById(`podium-col-${placeNum}`);
  const nameEl = document.getElementById(`podium-name-${placeNum}`);
  const avatarEl = document.getElementById(`podium-avatar-${placeNum}`);
  const valEl = document.getElementById(`podium-val-${placeNum}`);
  
  if (!player) {
    col.style.opacity = '0.3';
    nameEl.textContent = '-';
    avatarEl.textContent = '?';
    avatarEl.style.background = 'var(--secondary-accent)';
    valEl.textContent = '-';
    nameEl.classList.remove('dancing');
    return;
  }
  
  col.style.opacity = '1';
  const name = player.display_name || player.name || 'Anonymous';
  nameEl.textContent = name;
  nameEl.classList.add('dancing');
  avatarEl.textContent = name.charAt(0).toUpperCase();
  avatarEl.style.background = getAvatarColor(name);
  
  let valStr = '';
  const dict = I18N[state.lang] || I18N['en'];
  if (tabType === 'score') {
    valStr = `${player.total_score} pts`;
  } else if (tabType === 'speed') {
    valStr = player.avg_reaction_ms !== undefined && player.avg_reaction_ms > 0
      ? `${(player.avg_reaction_ms / 1000).toFixed(2)}s`
      : '--';
  } else if (tabType === 'accuracy') {
    valStr = dict.correct ? `${player.correct_count} ${dict.correct.replace('! 🎉', '').toLowerCase()}` : `${player.correct_count} correct`;
  }
  valEl.textContent = valStr;
}

// -----------------------------------------------------------------------------
// Toast Alerts
// -----------------------------------------------------------------------------
function showToast(messageKey, type = 'info', params = {}) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const dict = I18N[state.lang] || I18N['en'];
  let text = dict[messageKey] || messageKey;
  
  for (const [key, value] of Object.entries(params)) {
    text = text.replace(`{${key}}`, value);
  }
  
  toast.textContent = text;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'fadeIn 0.3s ease-out reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeJsString(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
}

// -----------------------------------------------------------------------------
// Lobby contributed reels pool management
// -----------------------------------------------------------------------------
async function fetchMyVaultReels() {
  if (!state.roomId) return;
  try {
    const reels = await apiCall(`/rooms/${state.roomId}/vault`);
    renderMyVaultReels(reels);
  } catch (err) {
    console.error("Failed to fetch my vault reels:", err);
  }
}

function renderMyVaultReels(reels) {
  const container = document.getElementById('my-pool-reels-list');
  const countSpan = document.getElementById('my-pool-count');
  if (!container) return;
  
  if (countSpan) {
    countSpan.textContent = reels.length;
  }
  
  const dict = I18N[state.lang] || I18N['en'];
  
  if (reels.length === 0) {
    container.innerHTML = `<p class="empty-text">${dict.noReelsYet || "You haven't added any reels to this room yet."}</p>`;
    return;
  }
  
  container.innerHTML = reels.map(reel => {
    let cleanLabel = '';
    const urlLower = reel.url.toLowerCase();
    
    if (urlLower.includes('instagram.com')) {
      const match = reel.url.match(/\/(reel|reels|p)\/([A-Za-z0-9_-]+)/);
      cleanLabel = match ? `IG: ${match[2].slice(0, 11)}` : `Instagram Link`;
    } else if (urlLower.includes('tiktok.com')) {
      const match = reel.url.match(/video\/(\d+)/);
      cleanLabel = match ? `TT: ${match[1].slice(0, 11)}` : `TikTok Link`;
    } else if (urlLower.includes('youtube.com/shorts/') || urlLower.includes('youtu.be/')) {
      let videoId = null;
      if (urlLower.includes('youtube.com/shorts/')) {
        const match = reel.url.match(/shorts\/([A-Za-z0-9_-]+)/);
        if (match) videoId = match[1];
      } else {
        const match = reel.url.match(/youtu\.be\/([A-Za-z0-9_-]+)/);
        if (match) videoId = match[1];
      }
      cleanLabel = videoId ? `YT: ${videoId.slice(0, 11)}` : `YouTube Link`;
    } else {
      cleanLabel = reel.url.slice(0, 30);
    }
    
    return `
      <div class="my-pool-item">
        <div class="my-pool-item-info">
          <span class="vault-item-tag ${reel.provider.toLowerCase()}">${reel.provider}</span>
          <span style="font-weight: 600; color: var(--text-secondary);">${cleanLabel}</span>
        </div>
        <button class="my-pool-item-remove" onclick="removeReelFromRoomPool('${reel.id}')" title="${dict.leave || 'Remove'}">❌</button>
      </div>
    `;
  }).join('');
}

async function removeReelFromRoomPool(reelId) {
  const dict = I18N[state.lang] || I18N['en'];
  if (!confirm(dict.removePoolConfirm || 'Remove this video from the room pool?')) return;
  try {
    await apiCall(`/rooms/${state.roomId}/vault/${reelId}`, { method: 'DELETE' });
    showToast('removedFromPool', 'success');
    fetchRoom();
  } catch (err) {
    const detail = err.response?.data?.detail;
    showToast(extractErrorMessage(detail) || 'removeFailed', 'error');
  }
}
