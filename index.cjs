const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} = require("discord.js");
const fs = require("fs");
const path = require("path");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ],
});

/*
  In-memory stores
*/
const activeCodes = new Map();
const opinieChannels = new Map();
const ticketCounter = new Map();
const fourMonthBlockList = new Map(); // guildId -> Set(userId)
const ticketCategories = new Map();
const dropChannels = new Map(); // <-- mapa kanałów gdzie można używać /drop
const sprawdzZaproszeniaCooldowns = new Map(); // userId -> lastTs
const inviteTotalJoined = new Map(); // guild -> userId -> liczba wszystkich dołączeń
const inviteFakeAccounts = new Map(); // guild -> userId -> liczba kont < 4 miesiące
const inviteBonusInvites = new Map(); // guild -> userId -> dodatkowe zaproszenia (z /ustawzaproszenia)
const inviteRewardsGiven = new Map(); // NEW: guild -> userId -> ile nagród już przyznano

// Helper: funkcja zwracająca poprawną formę słowa "zaproszenie"
function getInviteWord(count) {
  if (count === 1) return "zaproszenie";
  if (count >= 2 && count <= 4) return "zaproszenia";
  return "zaproszeń";
}

// NEW: weryfikacja
const verificationRoles = new Map(); // guildId -> roleId
const pendingVerifications = new Map(); // modalId -> { answer, guildId, userId, roleId }

const ticketOwners = new Map(); // channelId -> { claimedBy, userId, ticketMessageId, locked }

// NEW: keep last posted instruction message per channel so we can delete & re-post
const lastOpinionInstruction = new Map(); // channelId -> messageId
const lastDropInstruction = new Map(); // channelId -> messageId  <-- NEW for drop instructions
const lastInviteInstruction = new Map(); // channelId -> messageId  <-- NEW for invite instructions

// Mapa do przechowywania wyborów użytkowników dla kalkulatora
const kalkulatorData = new Map(); // userId -> { tryb, metoda, typ }

// Contest maps (new)
const contestParticipants = new Map(); // messageId -> Set(userId)
const contests = new Map(); // messageId -> { channelId, endsAt, winnersCount, title, prize, imageUrl }

// --- LEGITCHECK-REP info behavior --------------------------------------------------
// channel ID where users post freeform reps and the bot should post the informational embed
const REP_CHANNEL_ID = "1449840030947217529";

// cooldown (ms) per user between the bot posting the info embed
const INFO_EMBED_COOLDOWN_MS = 5 * 1000; // default 5s — change to desired value

// map used for throttling per-user
const infoCooldowns = new Map(); // userId -> timestamp (ms)

// banner/gif url to show at bottom of embed (change this to your gif/url)
const REP_EMBED_BANNER_URL =
  "https://share.creavite.co/693f180207e523c90b19fbf9.gif";

// track last info message posted by the bot per channel so we can delete it before posting a new one
const repLastInfoMessage = new Map(); // channelId -> messageId

// legit rep counter
let legitRepCount = 0;
let lastChannelRename = 0;
const CHANNEL_RENAME_COOLDOWN = 10 * 60 * 1000; // 10 minutes (Discord limit)
let pendingRename = false;

// NEW: cooldowns & limits
const DROP_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours per user
const OPINION_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes per user

const dropCooldowns = new Map(); // userId -> timestamp (ms)
const opinionCooldowns = new Map(); // userId -> timestamp (ms)

// Colors
const COLOR_BLUE = 0x00aaff;
const COLOR_YELLOW = 0xffd700;
const COLOR_GRAY = 0x808080;
const COLOR_RED = 0x8b0000;

// New maps for ticket close confirmation
const pendingTicketClose = new Map(); // channelId -> { userId, ts }

// ------------------ Invite tracking & protections ------------------
const guildInvites = new Map(); // guildId -> Map<code, uses>
const inviteCounts = new Map(); // guildId -> Map<inviterId, count>  (current cycle count)
const inviterOfMember = new Map(); // `${guildId}:${memberId}` -> inviterId
const INVITE_REWARD_THRESHOLD = 5;
const INVITE_REWARD_TEXT = "50k$"; // <-- zmienione z 40k$ na 50k$

// additional maps:
const inviteRewards = new Map(); // guildId -> Map<inviterId, rewardsGiven>
const inviterRateLimit = new Map(); // guildId -> Map<inviterId, [timestamps]> to limit invites per hour
// track members who left so we can undo "leave" counters if they rejoin
const leaveRecords = new Map(); // key = `${guildId}:${memberId}` -> inviterId

// keep invite cache up-to-date (global listeners, NOT inside GuildMemberAdd)
client.on("inviteCreate", (invite) => {
  try {
    const map = guildInvites.get(invite.guild.id) || new Map();
    map.set(invite.code, invite.uses || 0);
    guildInvites.set(invite.guild.id, map);
  } catch (e) {
    console.warn("inviteCreate handler error:", e);
  }
});
client.on("inviteDelete", (invite) => {
  try {
    const map = guildInvites.get(invite.guild.id);
    if (map) {
      map.delete(invite.code);
      guildInvites.set(invite.guild.id, map);
    }
  } catch (e) {
    console.warn("inviteDelete handler error:", e);
  }
});
// Invite rate-limit settings (zapobiega nadużyciom liczenia zaproszeń)
const INVITER_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 godzina
const INVITER_RATE_LIMIT_MAX = 10; // maksymalnie 10 zaproszeń w oknie (zmień wedle potrzeby)
// track how many people left per inviter (for /sprawdz-zaproszenia)
const inviteLeaves = new Map(); // guildId -> Map<inviterId, leftCount>
// -----------------------------------------------------

// Prefer Persistent Disk on Render, fallback to local file
const STORE_FILE = process.env.STORE_FILE
  ? path.resolve(process.env.STORE_FILE)
  : (fs.existsSync("/opt/render/project") ? "/opt/render/project/data/legit_store.json" : path.join(__dirname, "legit_store.json"));

try {
  const dir = path.dirname(STORE_FILE);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
} catch (e) {
  console.warn("Nie udało się przygotować katalogu dla STORE_FILE:", e);
}

try {
  const exists = fs.existsSync(STORE_FILE);
  const size = exists ? fs.statSync(STORE_FILE).size : 0;
  console.log(`[state] STORE_FILE=${STORE_FILE} exists=${exists} size=${size}`);
} catch (e) {
  console.warn("[state] Nie udało się odczytać informacji o STORE_FILE:", e);
}

// -------- Persistent storage helpers (invites, tickets, legit-rep) --------
function nestedObjectToMapOfMaps(source) {
  const top = new Map();
  if (!source || typeof source !== "object") return top;
  for (const [outerKey, innerObj] of Object.entries(source)) {
    const innerMap = new Map();
    if (innerObj && typeof innerObj === "object") {
      for (const [innerKey, value] of Object.entries(innerObj)) {
        innerMap.set(innerKey, value);
      }
    }
    top.set(outerKey, innerMap);
  }
  return top;
}

function mapOfMapsToPlainObject(topMap) {
  const obj = {};
  for (const [outerKey, innerMap] of topMap.entries()) {
    obj[outerKey] = {};
    if (innerMap && typeof innerMap.forEach === "function") {
      innerMap.forEach((value, innerKey) => {
        obj[outerKey][innerKey] = value;
      });
    }
  }
  return obj;
}

let saveStateTimeout = null;
function buildPersistentStateData() {
  // Convert contests to plain object
  const contestsObj = {};
  for (const [msgId, meta] of contests.entries()) {
    // ensure meta is serializable (avoid functions)
    contestsObj[msgId] = {
      ...(meta || {}),
      endsAt: meta && meta.endsAt ? meta.endsAt : null,
    };
  }

  // Convert contest participants to plain object
  const participantsObj = {};
  for (const [msgId, setOrMap] of contestParticipants.entries()) {
    // contestParticipants may store Set or Map — normalize to array of userIds
    if (setOrMap instanceof Set) {
      participantsObj[msgId] = Array.from(setOrMap);
    } else if (
      setOrMap &&
      typeof setOrMap === "object" &&
      typeof setOrMap.forEach === "function"
    ) {
      // if it's a Map(userId -> meta) convert to array of userIds
      participantsObj[msgId] = Array.from(setOrMap.keys());
    } else {
      participantsObj[msgId] = [];
    }
  }

  // optional: serialize fourMonthBlockList if you've added it
  const fourMonthObj = {};
  if (
    typeof fourMonthBlockList !== "undefined" &&
    fourMonthBlockList instanceof Map
  ) {
    for (const [gId, setOfUsers] of fourMonthBlockList.entries()) {
      fourMonthObj[gId] = Array.from(setOfUsers || []);
    }
  }

  const data = {
    legitRepCount,
    ticketCounter: Object.fromEntries(ticketCounter),
    ticketOwners: Object.fromEntries(ticketOwners),
    inviteCounts: mapOfMapsToPlainObject(inviteCounts),
    inviteRewards: mapOfMapsToPlainObject(inviteRewards),
    inviteLeaves: mapOfMapsToPlainObject(inviteLeaves),
    inviteRewardsGiven: mapOfMapsToPlainObject(inviteRewardsGiven),
    inviteTotalJoined: mapOfMapsToPlainObject(inviteTotalJoined),
    inviteFakeAccounts: mapOfMapsToPlainObject(inviteFakeAccounts),
    inviteBonusInvites: mapOfMapsToPlainObject(inviteBonusInvites),
    lastInviteInstruction: Object.fromEntries(lastInviteInstruction),
    contests: contestsObj,
    contestParticipants: participantsObj,
    fourMonthBlockList: fourMonthObj,
    weeklySales: Object.fromEntries(weeklySales),
    activeCodes: Object.fromEntries(activeCodes),
  };

  return data;
}

function flushPersistentStateSync() {
  try {
    const data = buildPersistentStateData();
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
    try {
      const size = fs.existsSync(STORE_FILE) ? fs.statSync(STORE_FILE).size : 0;
      console.log(`[state] flush ok -> ${STORE_FILE} size=${size}`);
    } catch (e) {
      // ignore
    }
  } catch (err) {
    console.error("Nie udało się zapisać stanu bota (flush):", err);
  }
}

function scheduleSavePersistentState() {
  // debounce writes to avoid spamming disk
  if (saveStateTimeout) return;
  saveStateTimeout = setTimeout(() => {
    saveStateTimeout = null;
    try {
      const data = buildPersistentStateData();
      fs.writeFile(STORE_FILE, JSON.stringify(data, null, 2), (err) => {
        if (err) {
          console.error("Nie udało się zapisać stanu bota:", err);
          console.error(`[state] save failed -> ${STORE_FILE}`);
          return;
        }
        try {
          const size = fs.existsSync(STORE_FILE) ? fs.statSync(STORE_FILE).size : 0;
          console.log(`[state] save ok -> ${STORE_FILE} size=${size}`);
        } catch (e) {
          // ignore
        }
      });
    } catch (err) {
      console.error("Błąd serializacji stanu bota:", err);
    }
  }, 2000);
}

function loadPersistentState() {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    if (!raw.trim()) return;

    const data = JSON.parse(raw);

    if (typeof data.legitRepCount === "number") {
      legitRepCount = data.legitRepCount;
    }

    if (data.ticketCounter && typeof data.ticketCounter === "object") {
      for (const [guildId, value] of Object.entries(data.ticketCounter)) {
        if (typeof value === "number") {
          ticketCounter.set(guildId, value);
        }
      }
    }

    if (data.ticketOwners && typeof data.ticketOwners === "object") {
      for (const [channelId, ticketData] of Object.entries(data.ticketOwners)) {
        if (ticketData && typeof ticketData === "object") {
          ticketOwners.set(channelId, ticketData);
        }
      }
    }
    if (
      data.fourMonthBlockList &&
      typeof data.fourMonthBlockList === "object"
    ) {
      for (const [gId, arr] of Object.entries(data.fourMonthBlockList)) {
        if (Array.isArray(arr)) {
          fourMonthBlockList.set(gId, new Set(arr));
        }
      }
    }

    if (data.inviteCounts) {
      const loaded = nestedObjectToMapOfMaps(data.inviteCounts);
      loaded.forEach((inner, guildId) => {
        inviteCounts.set(guildId, inner);
      });
    }

    if (data.inviteRewards) {
      const loaded = nestedObjectToMapOfMaps(data.inviteRewards);
      loaded.forEach((inner, guildId) => {
        inviteRewards.set(guildId, inner);
      });
    }

    if (data.inviteLeaves) {
      const loaded = nestedObjectToMapOfMaps(data.inviteLeaves);
      loaded.forEach((inner, guildId) => {
        inviteLeaves.set(guildId, inner);
      });
    }

    if (data.inviteRewardsGiven) {
      // NEW
      const loaded = nestedObjectToMapOfMaps(data.inviteRewardsGiven);
      loaded.forEach((inner, guildId) => {
        inviteRewardsGiven.set(guildId, inner);
      });
    }

    if (
      data.lastInviteInstruction &&
      typeof data.lastInviteInstruction === "object"
    ) {
      for (const [channelId, messageId] of Object.entries(
        data.lastInviteInstruction,
      )) {
        if (typeof messageId === "string") {
          lastInviteInstruction.set(channelId, messageId);
        }
      }
    }

    // Load contests
    if (data.contests && typeof data.contests === "object") {
      for (const [msgId, meta] of Object.entries(data.contests)) {
        if (meta && typeof meta.endsAt === "number") {
          contests.set(msgId, meta);
          // Schedule contest end if it hasn't ended yet
          const now = Date.now();
          if (meta.endsAt > now) {
            const delay = meta.endsAt - now;
            setTimeout(() => {
              endContestByMessageId(msgId).catch((e) => console.error(e));
            }, delay);
            console.log(
              `[contests] Przywrócono konkurs ${msgId}, zakończy się za ${Math.round(delay / 1000)}s`,
            );
          } else {
            // Contest should have ended, end it now
            setImmediate(() => {
              endContestByMessageId(msgId).catch((e) => console.error(e));
            });
          }
        }
      }
    }

    // Load contest participants
    if (
      data.contestParticipants &&
      typeof data.contestParticipants === "object"
    ) {
      for (const [msgId, arr] of Object.entries(data.contestParticipants)) {
        if (Array.isArray(arr)) {
          contestParticipants.set(msgId, new Set(arr));
        }
      }
    }

    // Load weekly sales
    if (data.weeklySales && typeof data.weeklySales === "object") {
      for (const [userId, salesData] of Object.entries(data.weeklySales)) {
        if (salesData && typeof salesData === "object" && typeof salesData.amount === "number") {
          weeklySales.set(userId, salesData);
        }
      }
    }

    // Load active codes
    if (data.activeCodes && typeof data.activeCodes === "object") {
      for (const [code, codeData] of Object.entries(data.activeCodes)) {
        if (codeData && typeof codeData === "object") {
          activeCodes.set(code, codeData);
        }
      }
    }

    // Load invite total joined
    if (data.inviteTotalJoined) {
      const loaded = nestedObjectToMapOfMaps(data.inviteTotalJoined);
      loaded.forEach((inner, guildId) => {
        inviteTotalJoined.set(guildId, inner);
      });
    }

    // Load invite fake accounts
    if (data.inviteFakeAccounts) {
      const loaded = nestedObjectToMapOfMaps(data.inviteFakeAccounts);
      loaded.forEach((inner, guildId) => {
        inviteFakeAccounts.set(guildId, inner);
      });
    }

    // Load invite bonus invites
    if (data.inviteBonusInvites) {
      const loaded = nestedObjectToMapOfMaps(data.inviteBonusInvites);
      loaded.forEach((inner, guildId) => {
        inviteBonusInvites.set(guildId, inner);
      });
    }

    try {
      let fakeGuilds = 0;
      let fakeEntries = 0;
      for (const [gId, inner] of inviteFakeAccounts.entries()) {
        fakeGuilds++;
        if (inner && typeof inner.size === "number") fakeEntries += inner.size;
      }
      console.log(
        `[state] load ok <- ${STORE_FILE} inviteFakeAccounts guilds=${fakeGuilds} entries=${fakeEntries}`,
      );
    } catch (e) {
      // ignore
    }
    console.log("Załadowano zapisany stan bota z pliku.");
  } catch (err) {
    console.error("Nie udało się odczytać stanu bota z pliku:", err);
  }
}

function generateCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 10; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function getNextTicketNumber(guildId) {
  const current = ticketCounter.get(guildId) || 0;
  const next = current + 1;
  ticketCounter.set(guildId, next);
  scheduleSavePersistentState();
  return next;
}

// Load persisted state once on startup (after maps are defined)
loadPersistentState();

// Flush debounced state on shutdown so counters don't reset on restart
process.once("SIGINT", () => {
  try {
    if (saveStateTimeout) {
      clearTimeout(saveStateTimeout);
      saveStateTimeout = null;
    }
    flushPersistentStateSync();
  } finally {
    process.exit(0);
  }
});
process.once("SIGTERM", () => {
  try {
    if (saveStateTimeout) {
      clearTimeout(saveStateTimeout);
      saveStateTimeout = null;
    }
    flushPersistentStateSync();
  } finally {
    process.exit(0);
  }
});

// Defaults provided by user (kept mainly for categories / names)
const DEFAULT_GUILD_ID = "1350446732365926491";
const REWARDS_CATEGORY_ID = "1449455567641907351";
const DEFAULT_NAMES = {
  dropChannelName: "🎁-×┃dropy",
  verificationRoleName: "@> | 💲 klient",
  categories: {
    "zakup-0-20": "zakup 0-20",
    "zakup-20-50": "zakup 20-50",
    "zakup-50-100": "zakup 50-100",
    "zakup-100-200": "zakup 100-200+",
    sprzedaz: "sprzedaz",
    "odbior-nagrody": "nagroda za zaproszenia",
    "konkurs-nagrody": "nagroda za konkurs",
    inne: "inne",
  },
};

const commands = [
  new SlashCommandBuilder()
    .setName("drop")
    .setDescription("Wylosuj zniżkę na zakupy w sklepie!")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("panelkalkulator")
    .setDescription("Wyślij panel kalkulatora waluty na kanał")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("ticketpanel")
    .setDescription("Wyślij TicketPanel na kanał")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Spis wszystkich komend bota")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("zaproszeniastats")
    .setDescription("Edytuj statystyki zaproszeń (admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) =>
      o
        .setName("kategoria")
        .setDescription(
          "Wybierz kategorię: prawdziwe / opuszczone / mniej4mies / dodatkowe",
        )
        .setRequired(true)
        .addChoices(
          { name: "prawdziwe", value: "prawdziwe" },
          { name: "opuszczone", value: "opuszczone" },
          { name: "mniej4mies", value: "mniej4mies" },
          { name: "dodatkowe", value: "dodatkowe" },
        ),
    )
    .addStringOption((o) =>
      o
        .setName("akcja")
        .setDescription("dodaj / odejmij / ustaw / wyczysc")
        .setRequired(true)
        .addChoices(
          { name: "dodaj", value: "dodaj" },
          { name: "odejmij", value: "odejmij" },
          { name: "ustaw", value: "ustaw" },
          { name: "wyczysc", value: "wyczysc" },
        ),
    )
    .addIntegerOption((o) =>
      o
        .setName("liczba")
        .setDescription("Ilość (opcjonalnie)")
        .setRequired(false),
    )
    .addUserOption((o) =>
      o
        .setName("komu")
        .setDescription("Dla kogo (opcjonalnie)")
        .setRequired(false),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("zamknij")
    .setDescription("Zamknij ticket")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("panelweryfikacja")
    .setDescription("Wyślij panel weryfikacji na kanał")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("opinia")
    .setDescription("Podziel sie opinią o naszym sklepie!")
    .addIntegerOption((option) =>
      option
        .setName("czas_oczekiwania")
        .setDescription("Ocena dotycząca czasu oczekiwania (1-5 gwiazdek)")
        .setRequired(true)
        .addChoices(
          { name: "⭐", value: 1 },
          { name: "⭐ ⭐", value: 2 },
          { name: "⭐ ⭐ ⭐", value: 3 },
          { name: "⭐ ⭐ ⭐ ⭐", value: 4 },
          { name: "⭐ ⭐ ⭐ ⭐ ⭐", value: 5 },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName("jakosc_produktu")
        .setDescription("Ocena jakości produktu (1-5)")
        .setRequired(true)
        .addChoices(
          { name: "⭐", value: 1 },
          { name: "⭐ ⭐", value: 2 },
          { name: "⭐ ⭐ ⭐", value: 3 },
          { name: "⭐ ⭐ ⭐ ⭐", value: 4 },
          { name: "⭐ ⭐ ⭐ ⭐ ⭐", value: 5 },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName("cena_produktu")
        .setDescription("Ocena ceny produktu (1-5)")
        .setRequired(true)
        .addChoices(
          { name: "⭐", value: 1 },
          { name: "⭐ ⭐", value: 2 },
          { name: "⭐ ⭐ ⭐", value: 3 },
          { name: "⭐ ⭐ ⭐ ⭐", value: 4 },
          { name: "⭐ ⭐ ⭐ ⭐ ⭐", value: 5 },
        ),
    )
    .addStringOption((option) =>
      option
        .setName("tresc_opinii")
        .setDescription("Treść opinii")
        .setRequired(true),
    )
    .toJSON(),
  // NEW: /wyczysckanal command
  new SlashCommandBuilder()
    .setName("wyczysckanal")
    .setDescription(
      "Wyczyść wiadomości na kanale (wszystko / ilosc-wiadomosci)",
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((option) =>
      option
        .setName("tryb")
        .setDescription("Wybierz tryb: wszystko lub ilosc")
        .setRequired(true)
        .addChoices(
          { name: "Wszystko", value: "wszystko" },
          { name: "Ilość wiadomości", value: "ilosc" },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName("ilosc")
        .setDescription(
          "Ile wiadomości usunąć (1-100) — wymagane gdy tryb=ilosc",
        )
        .setRequired(false),
    )
    .toJSON(),
  // NEW: /resetlc command - reset legitcheck counter
  new SlashCommandBuilder()
    .setName("resetlc")
    .setDescription("Reset liczby legitchecków do zera (admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  // NEW: /zresetujczasoczekiwania command - clear cooldowns for drop/opinia/info
  new SlashCommandBuilder()
    .setName("zresetujczasoczekiwania")
    .setDescription("Resetuje czasy oczekiwania dla /drop i /opinia")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  // NEW helper admin commands for claiming/unclaiming
  new SlashCommandBuilder()
    .setName("przejmij")
    .setDescription("Przejmij aktualny ticket (admin helper)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("odprzejmij")
    .setDescription("Odprzejmij aktualny ticket (admin helper)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  // UPDATED: sendmessage (interactive flow)
  new SlashCommandBuilder()
    .setName("sendmessage")
    .setDescription(
      "Interaktywnie wyślij wiadomość przez bota: po użyciu komendy bot poprosi Cię o treść (admin)",
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((o) =>
      o
        .setName("kanal")
        .setDescription(
          "Kanał docelowy (opcjonalnie). Jeśli nie podasz, użyty zostanie aktualny kanał.",
        )
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText),
    )
    .toJSON(),
  // RENAMED: sprawdz-zaproszenia (was sprawdz-zapro)
  new SlashCommandBuilder()
    .setName("sprawdz-zaproszenia")
    .setDescription("Sprawdź ile posiadasz zaproszeń")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("rozliczenie")
    .setDescription("Dodaj kwotę sprzedaży do cotygodniowych rozliczeń")
    .addIntegerOption((option) =>
      option
        .setName("kwota")
        .setDescription("Kwota sprzedaży w złotych")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(999999)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("rozliczeniezakoncz")
    .setDescription("Wyślij podsumowanie rozliczeń (tylko właściciel)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("statusbota")
    .setDescription("Pokaż szczegółowy status bota")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // Tylko właściciel
    .toJSON(),
  new SlashCommandBuilder()
    .setName("rozliczenieustaw")
    .setDescription("Ustaw tygodniową sumę rozliczenia dla użytkownika (tylko właściciel)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option
        .setName("uzytkownik")
        .setDescription("Użytkownik")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("akcja")
        .setDescription("Dodaj lub odejmij kwotę")
        .setRequired(true)
        .addChoices(
          { name: "Dodaj", value: "dodaj" },
          { name: "Odejmij", value: "odejmij" },
          { name: "Ustaw", value: "ustaw" }
        )
    )
    .addIntegerOption((option) =>
      option
        .setName("kwota")
        .setDescription("Kwota do dodania/odejmowania/ustawienia")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(999999)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("stworzkonkurs")
    .setDescription(
      "Utwórz konkurs z przyciskiem do udziału i losowaniem zwycięzców",
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

// Helper: human-readable ms
function humanizeMs(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Helper: sprawdź czy użytkownik jest admin lub sprzedawca
function isAdminOrSeller(member) {
  if (!member) return false;
  const SELLER_ROLE_ID = "1350786945944391733";

  // Sprawdź czy ma rolę sprzedawcy
  if (
    member.roles &&
    member.roles.cache &&
    member.roles.cache.has(SELLER_ROLE_ID)
  ) {
    return true;
  }

  // Sprawdź Administrator
  if (
    member.permissions &&
    member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return true;
  }

  return false;
}

function parseShortNumber(input) {
  if (!input) return NaN;
  const str = input.toString().trim().toLowerCase().replace(/\s+/g, "");
  const match = str.match(/^(\d+)(k|m)?$/);
  if (!match) return NaN;
  const base = parseInt(match[1], 10);
  const suffix = match[2];
  if (!suffix) return base;
  if (suffix === "k") return base * 1000;
  if (suffix === "m") return base * 1_000_000;
  return NaN;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function formatShortWaluta(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const fmt = (x) => {
    const rounded = Math.round((Number(x) + Number.EPSILON) * 100) / 100;
    if (Number.isInteger(rounded)) return `${rounded}`;
    return `${rounded}`.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
  };

  if (abs >= 1_000_000) return `${fmt(v / 1_000_000)}m`;
  if (abs >= 1_000) return `${fmt(v / 1_000)}k`;
  return `${Math.floor(v)}`;
}

function getPaymentFeePercent(methodRaw) {
  const m = (methodRaw || "").toString().trim().toLowerCase();

  if (m.startsWith("blik")) return 0;
  if (m.startsWith("kod blik")) return 10;
  if (m === "psc bez paragonu" || m.startsWith("psc bez paragonu")) return 20;
  if (m === "psc" || m.startsWith("psc ")) return 10;
  if (m.includes("paypal")) return 5;
  if (m.includes("ltc")) return 5;

  return 0;
}

function getRateForPlnAmount(pln, serverRaw) {
  const server = (serverRaw || "").toString().trim().toUpperCase();

  if (server === "ANARCHIA_BOXPVP") return 650000;
  if (server === "ANARCHIA_LIFESTEAL") {
    if (Number(pln) >= 100) return 5000;
    return 4500;
  }
  if (server === "PYK_MC") {
    if (Number(pln) >= 100) return 4000;
    return 3500;
  }

  // fallback (stary cennik)
  if (Number(pln) >= 100) return 5000;
  return 4500;
}

// Helper: find a bot message in a channel matching a predicate on embed
async function findBotMessageWithEmbed(channel, matchFn) {
  try {
    const fetched = await channel.messages.fetch({ limit: 100 });
    for (const msg of fetched.values()) {
      if (
        msg.author?.id === client.user.id &&
        msg.embeds &&
        msg.embeds.length
      ) {
        const emb = msg.embeds[0];
        try {
          if (matchFn(emb)) return msg;
        } catch (e) {
          // match function error — skip
        }
      }
    }
  } catch (e) {
    // ignore fetch errors (no perms)
  }
  return null;
}

// Helper: determine if a channel is considered a ticket channel (based on categories)
function isTicketChannel(channel) {
  if (!channel || !channel.guild) return false;
  if (channel.parentId && String(channel.parentId) === String(REWARDS_CATEGORY_ID))
    return true;
  const cats = ticketCategories.get(channel.guild.id);
  if (cats) {
    for (const id of Object.values(cats)) {
      if (id === channel.parentId) return true;
    }
  }
  // fallback: name starts with ticket-
  if (channel.name && channel.name.toLowerCase().startsWith("ticket-"))
    return true;
  return false;
}

// Helper: rebuild/edit ticket message components to reflect claim/unclaim state in a safe manner
async function editTicketMessageButtons(channel, messageId, claimerId = null) {
  try {
    const ch = channel;
    if (!ch) return;
    const msg = await ch.messages.fetch(messageId).catch(() => null);
    if (!msg) return;

    const newRows = [];

    for (const row of msg.components) {
      const newRow = new ActionRowBuilder();
      const comps = [];

      for (const comp of row.components) {
        const cid = comp.customId || "";
        const label = comp.label || null;
        const style = comp.style || ButtonStyle.Secondary;
        const emoji = comp.emoji || null;
        const disabledOrig = !!comp.disabled;

        // Normalize known ticket button types
        if (cid.startsWith("ticket_claim_")) {
          if (claimerId) {
            // show disabled claim to indicate taken
            comps.push(
              new ButtonBuilder()
                .setCustomId(
                  `ticket_claim_${cid.split("_").slice(2).join("_")}`,
                )
                .setLabel("Przejmij")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            );
          } else {
            comps.push(
              new ButtonBuilder()
                .setCustomId(cid)
                .setLabel("Przejmij")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(false),
            );
          }
        } else if (cid.startsWith("ticket_unclaim_")) {
          const channelIdPart = cid.split("_")[2] || "";
          if (claimerId) {
            // enable unclaim for this claimer (customId includes claimerId)
            comps.push(
              new ButtonBuilder()
                .setCustomId(`ticket_unclaim_${channelIdPart}_${claimerId}`)
                .setLabel("Odprzejmij")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(false),
            );
          } else {
            // disabled unclaim
            comps.push(
              new ButtonBuilder()
                .setCustomId(`ticket_unclaim_${channelIdPart}`)
                .setLabel("Odprzejmij")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            );
          }
        } else {
          // keep other buttons as-is (close/settings/code). Recreate them to avoid component reuse issues.
          if (cid) {
            try {
              const btn = new ButtonBuilder()
                .setCustomId(cid)
                .setLabel(label || "")
                .setStyle(style)
                .setDisabled(disabledOrig);
              if (emoji) btn.setEmoji(emoji);
              comps.push(btn);
            } catch (e) {
              // fallback: skip component if something unexpected
            }
          } else {
            // non-interactive component (unlikely) — skip
          }
        }
      }

      try {
        newRow.addComponents(...comps);
        newRows.push(newRow);
      } catch (e) {
        // if row overflows, fallback to original row
        newRows.push(row);
      }
    }

    // Edit message with new rows
    await msg.edit({ components: newRows }).catch(() => null);
  } catch (err) {
    console.error("editTicketMessageButtons error:", err);
  }
}

async function registerCommands() {
  try {
    console.log("Rejestrowanie slash commands...");

    // Prefer ustawienie BOT_ID przez zmienną środowiskową
    const BOT_ID = process.env.DISCORD_BOT_ID || "1449397101032112139";

    // Rejestruj komendy na konkretnym serwerze (szybsze, natychmiastowe)
    try {
      await rest.put(
        Routes.applicationGuildCommands(BOT_ID, DEFAULT_GUILD_ID),
        {
          body: commands,
        },
      );
      console.log(`Komendy zarejestrowane dla guild ${DEFAULT_GUILD_ID}`);
    } catch (e) {
      console.warn(
        "Nie udało się zarejestrować komend na serwerze:",
        e.message || e,
      );
    }

    // Opcjonalnie: rejestruj globalnie tylko gdy jawnie to włączysz (globalne propagują się długo)
    if (process.env.REGISTER_GLOBAL === "true") {
      try {
        // Krótka przerwa żeby Discord mógł przepuścić zmiany (opcjonalne)
        await new Promise((r) => setTimeout(r, 1500));
        await rest.put(Routes.applicationCommands(BOT_ID), {
          body: commands,
        });
        console.log("Globalne slash commands zarejestrowane!");
      } catch (e) {
        console.warn(
          "Nie udało się zarejestrować globalnych komend:",
          e.message || e,
        );
      }
    } else {
      console.log(
        "Pominięto rejestrację globalnych komend (ustaw REGISTER_GLOBAL=true aby włączyć).",
      );
    }
  } catch (error) {
    console.error("Błąd rejestracji komend:", error);
  }
}

// improved apply defaults (tries to find resources by name / fallback)
async function applyDefaultsForGuild(guildId) {
  try {
    const guild =
      client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId));
    if (!guild) return;

    const normalize = (s = "") =>
      s
        .toString()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9 ]/gi, "")
        .trim()
        .toLowerCase();

    // find opinie channel by name
    const opinie = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        (c.name === "⭐-×┃opinie-klientow" ||
          normalize(c.name).includes("opinie") ||
          normalize(c.name).includes("opinie-klientow")),
    );
    if (opinie) {
      opinieChannels.set(guildId, opinie.id);
      console.log(`Ustawiono domyślny kanał opinii: ${opinie.id}`);
    }

    // find drop channel by name
    const drop = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        (c.name === DEFAULT_NAMES.dropChannelName ||
          normalize(c.name) === normalize(DEFAULT_NAMES.dropChannelName)),
    );
    if (drop) {
      dropChannels.set(guildId, drop.id);
      console.log(`Ustawiono domyślny kanał drop: ${drop.id}`);
    }

    // find verification role by exact name OR fallback to searching for "klient"
    let role =
      guild.roles.cache.find(
        (r) => r.name === DEFAULT_NAMES.verificationRoleName,
      ) ||
      guild.roles.cache.find((r) =>
        normalize(r.name).includes(normalize("klient")),
      );

    if (role) {
      verificationRoles.set(guildId, role.id);
      console.log(
        `Ustawiono domyślną rolę weryfikacji: ${role.id} (${role.name})`,
      );
    } else {
      console.log(
        `Nie znaleziono domyślnej roli weryfikacji w guild ${guildId}. Szukana nazwa: "${DEFAULT_NAMES.verificationRoleName}" lub zawierająca "klient".`,
      );
    }

    // find and set ticket categories (by name or normalized fallback)
    const categoriesMap = {};
    for (const key of Object.keys(DEFAULT_NAMES.categories)) {
      const catName = DEFAULT_NAMES.categories[key];
      const cat = guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildCategory &&
          (c.name === catName ||
            normalize(c.name).includes(normalize(catName))),
      );
      if (cat) {
        categoriesMap[key] = cat.id;
        console.log(`Ustawiono kategorię ${key} -> ${cat.id}`);
      }
    }
    if (Object.keys(categoriesMap).length > 0) {
      ticketCategories.set(guildId, categoriesMap);
    }
  } catch (error) {
    console.error("Błąd ustawiania domyślnych zasobów:", error);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Bot zalogowany jako ${c.user.tag}`);
  console.log(`Bot jest na ${c.guilds.cache.size} serwerach`);

    // --- Webhook startowy do Discorda ---
  try {
    const webhookUrl = process.env.UPTIME_WEBHOOK;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `🟢 Bot **${c.user.tag}** został uruchomiony i działa poprawnie.`
        })
      });
      console.log("Wysłano webhook startowy.");
    } else {
      console.log("Brak UPTIME_WEBHOOK w zmiennych środowiskowych.");
    }
  } catch (err) {
    console.error("Błąd wysyłania webhooka startowego:", err);
  }

  // Ustaw status - gra w NewShop
  try {
    c.user.setActivity(`LegitRepy: ${legitRepCount} 🛒`, { type: 0 });
    setInterval(
      () => c.user.setActivity(`LegitRepy: ${legitRepCount} 🛒`, { type: 0 }),
      60000,
    );
  } catch (e) {
    // aktywność może być niedostępna na bocie, ignoruj błąd
  }

  await registerCommands();

  // try to apply defaults on the provided server id
  await applyDefaultsForGuild(DEFAULT_GUILD_ID);

  // also apply defaults for all cached guilds (if names match)
  client.guilds.cache.forEach((g) => {
    applyDefaultsForGuild(g.id).catch((e) => console.error(e));
  });

  // Read current rep count from channel name
  try {
    const repChannel = await c.channels.fetch(REP_CHANNEL_ID).catch(() => null);
    if (repChannel && repChannel.name) {
      const match = repChannel.name.match(/➔(\d+)$/);
      if (match) {
        legitRepCount = parseInt(match[1], 10);
        console.log(`Odczytano liczbę repów z kanału: ${legitRepCount}`);
        scheduleSavePersistentState();
      }
    }

    // Try to find previously sent rep info message so we can reuse it
    if (repChannel) {
      const found = await findBotMessageWithEmbed(repChannel, (emb) => {
        return (
          emb.description &&
          typeof emb.description === "string" &&
          emb.description.includes("New Shop × LEGIT CHECK")
        );
      });
      if (found) {
        repLastInfoMessage.set(repChannel.id, found.id);
        console.log(
          `[ready] Znalazłem istniejącą wiadomość info-rep: ${found.id}`,
        );
      }
    }

    // Try to find previously sent opinion instruction messages in cached guilds
    client.guilds.cache.forEach(async (g) => {
      const opinId = opinieChannels.get(g.id);
      if (opinId) {
        try {
          const ch = await client.channels.fetch(opinId).catch(() => null);
          if (ch) {
            const found = await findBotMessageWithEmbed(
              ch,
              (emb) =>
                typeof emb.description === "string" &&
                (emb.description.includes(
                  "Użyj komendy </opinia:1454974442873553113>",
                ) ||
                  emb.description.includes("Użyj komendy `/opinia`")),
            );
            if (found) {
              lastOpinionInstruction.set(ch.id, found.id);
              console.log(
                `[ready] Znalazłem istniejącą instrukcję opinii: ${found.id} w kanale ${ch.id}`,
              );
            }
          }
        } catch (e) {
          // ignore
        }
      }

      // Try to find previously sent drop instruction messages
      const dropId = dropChannels.get(g.id);
      if (dropId) {
        try {
          const chd = await client.channels.fetch(dropId).catch(() => null);
          if (chd) {
            const foundDrop = await findBotMessageWithEmbed(
              chd,
              (emb) =>
                typeof emb.description === "string" &&
                (emb.description.includes(
                  "Użyj komendy </drop:1454974442370240585>",
                ) ||
                  emb.description.includes(
                    "`🎁` Użyj komendy </drop:1454974442370240585>",
                  ) ||
                  emb.description.includes("Użyj komendy `/drop`")),
            );
            if (foundDrop) {
              lastDropInstruction.set(chd.id, foundDrop.id);
              console.log(
                `[ready] Znalazłem istniejącą instrukcję drop: ${foundDrop.id} w kanale ${chd.id}`,
              );
            }
          }
        } catch (e) {
          // ignore
        }
      }

      // Try to find previously sent invite instruction messages (zaproszenia)
      try {
        const zapCh =
          g.channels.cache.find(
            (c) =>
              c.type === ChannelType.GuildText &&
              (c.name === "📨-×┃zaproszenia" ||
                c.name.toLowerCase().includes("zaproszen") ||
                c.name.toLowerCase().includes("zaproszenia")),
          ) || null;
        if (zapCh) {
          // First try to use saved message ID from file
          const savedId = lastInviteInstruction.get(zapCh.id);
          let foundExisting = false;
          if (savedId) {
            try {
              const savedMsg = await zapCh.messages
                .fetch(savedId)
                .catch(() => null);
              if (savedMsg && savedMsg.author.id === client.user.id) {
                console.log(
                  `[ready] Używam zapisanej wiadomości informacyjnej: ${savedId} w kanale ${zapCh.id}`,
                );
                // Message exists, we're good
                foundExisting = true;
              }
            } catch (e) {
              // Message doesn't exist, try to find it
            }
          }

          // If saved message doesn't exist, try to find it by content
          if (!foundExisting) {
            const foundInvite = await findBotMessageWithEmbed(
              zapCh,
              (emb) =>
                typeof emb.description === "string" &&
                (emb.description.includes(
                  "Użyj komendy /sprawdz-zaproszenia",
                ) ||
                  emb.description.includes("sprawdz-zaproszenia")),
            );
            if (foundInvite) {
              lastInviteInstruction.set(zapCh.id, foundInvite.id);
              scheduleSavePersistentState();
              console.log(
                `[ready] Znalazłem istniejącą instrukcję zaproszeń: ${foundInvite.id} w kanale ${zapCh.id}`,
              );
            }
          }
        }
      } catch (e) {
        // ignore
      }
    });
  } catch (err) {
    console.error(
      "Błąd odczytywania licznika repów lub wyszukiwania wiadomości:",
      err,
    );
  }

  // Initialize invite cache for all guilds
  client.guilds.cache.forEach(async (guild) => {
    try {
      const invites = await guild.invites.fetch().catch(() => null);
      if (!invites) return;
      const map = new Map();
      invites.each((inv) => map.set(inv.code, inv.uses));
      guildInvites.set(guild.id, map);
      // ensure inviteCounts map exists
      if (!inviteCounts.has(guild.id)) inviteCounts.set(guild.id, new Map());
      if (!inviteRewards.has(guild.id)) inviteRewards.set(guild.id, new Map());
      if (!inviteRewardsGiven.has(guild.id))
        inviteRewardsGiven.set(guild.id, new Map()); // NEW
      if (!inviterRateLimit.has(guild.id))
        inviterRateLimit.set(guild.id, new Map());
      if (!inviteLeaves.has(guild.id)) inviteLeaves.set(guild.id, new Map());
      console.log(`[invites] Zainicjalizowano invites cache dla ${guild.id}`);
    } catch (err) {
      console.warn("[invites] Nie udało się pobrać invite'ów dla guild:", err);
    }
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
    } else if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    }
  } catch (error) {
    console.error("Błąd obsługi interakcji:", error);
  }
});
async function handleModalSubmit(interaction) {
  const id = interaction.customId;

  // --- ILE OTRZYMAM ---
  if (id === "modal_ile_otrzymam") {
    const kwotaStr = interaction.fields.getTextInputValue("kwota");
    const tryb = interaction.fields.getTextInputValue("tryb");
    const metoda = interaction.fields.getTextInputValue("metoda");

    const kwota = Number(kwotaStr);
    if (isNaN(kwota) || kwota <= 0) {
      return interaction.reply({
        ephemeral: true,
        content: "❌ Podaj poprawną kwotę w PLN.",
      });
    }

    const rate = getRateForPlnAmount(kwota, tryb);
    const feePercent = getPaymentFeePercent(metoda);

    const base = kwota * rate;
    const fee = base * (feePercent / 100);
    const finalAmount = Math.floor(base - fee);

    return interaction.reply({
      ephemeral: true,
      content:
        `💰 **Otrzymasz:** ${finalAmount.toLocaleString()}\n` +
        `📉 Kurs: ${rate}\n` +
        `💸 Prowizja: ${feePercent}%\n` +
        `📌 Tryb: ${tryb}\n` +
        `📌 Metoda: ${metoda}`,
    });
  }

  // --- ILE MUSZĘ DAĆ ---
  if (id === "modal_ile_musze_dac") {
    const walutaStr = interaction.fields.getTextInputValue("waluta");
    const tryb = interaction.fields.getTextInputValue("tryb");
    const metoda = interaction.fields.getTextInputValue("metoda");

    const amount = parseShortNumber(walutaStr);
    if (isNaN(amount) || amount <= 0) {
      return interaction.reply({
        ephemeral: true,
        content: "❌ Podaj poprawną ilość waluty (np. 125k / 1m).",
      });
    }

    const rate = getRateForPlnAmount(100, tryb);
    const feePercent = getPaymentFeePercent(metoda);

    const plnBase = amount / rate;
    const fee = plnBase * (feePercent / 100);
    const finalPln = Number((plnBase + fee).toFixed(2));

    return interaction.reply({
      ephemeral: true,
      content:
        `💸 **Musisz zapłacić:** ${finalPln} PLN\n` +
        `📉 Kurs: ${rate}\n` +
        `💸 Prowizja: ${feePercent}%\n` +
        `📌 Tryb: ${tryb}\n` +
        `📌 Metoda: ${metoda}`,
    });
  }

  // --- INNE MODALE (TWOJE) ---
  // tu zostawiasz resztę obsługi modali
}

async function handleKalkulatorSelect(interaction) {
  try {
    // Defer the interaction to avoid timeout
    await interaction.deferUpdate();

    const userId = interaction.user.id;
    const customId = interaction.customId;
    const selectedValue = interaction.values[0];

    // Pobierz aktualne dane użytkownika
    const userData = kalkulatorData.get(userId) || {};

    // Zaktualizuj odpowiednie pole
    if (customId === "kalkulator_tryb") {
      userData.tryb = selectedValue;
    } else if (customId === "kalkulator_metoda") {
      userData.metoda = selectedValue;
    }

    // Zapisz dane
    kalkulatorData.set(userId, userData);

    // Jeśli oba pola są wypełnione, oblicz i pokaż wynik
    if (userData.tryb && userData.metoda) {
      await handleKalkulatorSubmit(interaction, userData.typ);
    }
  } catch (error) {
    console.error("Błąd w handleKalkulatorSelect:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Wystąpił błąd podczas przetwarzania wyboru. Spróbuj ponownie.",
        ephemeral: true
      });
    } else {
      await interaction.followUp({
        content: "❌ Wystąpił błąd podczas przetwarzania wyboru. Spróbuj ponownie.",
        ephemeral: true
      });
    }
  }
}

async function handleKalkulatorSubmit(interaction, typ) {
  try {
    const userId = interaction.user.id;
    const userData = kalkulatorData.get(userId) || {};

    if (!userData.tryb || !userData.metoda) {
      await interaction.followUp({
        content: "❌ Proszę wybrać zarówno tryb jak i metodę płatności.",
        ephemeral: true,
      });
      return;
    }

    const feePercent = getPaymentFeePercent(userData.metoda);

    if (typ === "otrzymam") {
      const kwota = userData.kwota;
      const effectivePln = kwota * (1 - feePercent / 100);
      const rate = getRateForPlnAmount(kwota, userData.tryb);
      const waluta = Math.floor(effectivePln * rate);
      const kwotaZl = Math.trunc(Number(kwota) || 0);
      const walutaShort = formatShortWaluta(waluta);

      const msg = `> \`🔢\` × **Płacąc nam ${kwotaZl}zł (${userData.metoda} prowizja: ${feePercent}%) otrzymasz:** \`${walutaShort}\` **(${waluta} $)**`;

      await interaction.editReply({
        content: msg,
        embeds: [],
        components: []
      });
    } else {
      const waluta = userData.waluta;
      const server = (userData.tryb || "").toString().toUpperCase();
      let rate;
      if (server === "ANARCHIA_BOXPVP") {
        rate = 650000;
      } else if (server === "ANARCHIA_LIFESTEAL") {
        const estimatedPln4500 = waluta / 4500;
        rate = estimatedPln4500 >= 100 ? 5000 : 4500;
      } else {
        // PYK MC
        const estimatedPln3500 = waluta / 3500;
        rate = estimatedPln3500 >= 100 ? 4000 : 3500;
      }
      const baseRaw = waluta / rate;
      const basePln = round2(baseRaw);
      const feePln = round2(basePln * feePercent / 100);
      const totalPln = round2(basePln + feePln);

      const totalZl = Math.trunc(Number(totalPln) || 0);
      const walutaInt = Math.floor(Number(waluta) || 0);
      const walutaShort = formatShortWaluta(walutaInt);

      const msg = `> \`🔢\` × **Aby otrzymać:** \`${walutaShort}\` **(${walutaInt} $)** **musisz zapłacić ${totalZl}zł (${userData.metoda} prowizja: ${feePercent}%)**`;

      await interaction.editReply({
        content: msg,
        embeds: [],
        components: []
      });
    }

    // Wyczyść dane użytkownika
    kalkulatorData.delete(userId);
  } catch (error) {
    console.error("Błąd w handleKalkulatorSubmit:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Wystąpił błąd podczas obliczania. Spróbuj ponownie.",
        ephemeral: true
      });
    } else {
      await interaction.followUp({
        content: "❌ Wystąpił błąd podczas obliczania. Spróbuj ponownie.",
        ephemeral: true
      });
    }
  }
}

async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;
  const botName = client.user?.username || "NEWSHOP";

  // KONKURSY: obsługa przycisków konkursowych
  if (customId.startsWith("konkurs_join_")) {
    const msgId = customId.replace("konkurs_join_", "");
    
    const modal = new ModalBuilder()
      .setCustomId(`konkurs_join_modal_${msgId}`)
      .setTitle("Dołącz do konkursu");

    const nickInput = new TextInputBuilder()
      .setCustomId("konkurs_nick")
      .setLabel("Podaj swój nick Minecraft")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(50)
      .setPlaceholder("Na ten nick nadamy nagrode");

    const row1 = new ActionRowBuilder().addComponents(nickInput);
    modal.addComponents(row1);

    await interaction.showModal(modal);
    return;
  }

  if (customId.startsWith("konkurs_leave_")) {
    const msgId = customId.replace("konkurs_leave_", "");
    await handleKonkursLeave(interaction, msgId);
    return;
  }

  if (customId.startsWith("konkurs_cancel_leave_")) {
    const msgId = customId.replace("konkurs_cancel_leave_", "");
    await handleKonkursCancelLeave(interaction, msgId);
    return;
  }

  // NEW: verification panel button
  if (customId.startsWith("verify_panel_")) {
    // very simple puzzles for preschool level: addition and multiplication with small numbers
    let expression;
    let answer;

    const operators = ["+", "*"];
    const op = operators[Math.floor(Math.random() * operators.length)];

    if (op === "+") {
      // addition: numbers 1-5
      const left = Math.floor(Math.random() * 5) + 1; // 1-5
      const right = Math.floor(Math.random() * 5) + 1; // 1-5
      expression = `${left} + ${right}`;
      answer = left + right;
    } else {
      // multiplication: small multiplier 1-3
      const left = Math.floor(Math.random() * 5) + 1; // 1-5
      const right = Math.floor(Math.random() * 3) + 1; // 1-3
      expression = `${left} * ${right}`;
      answer = left * right;
    }

    const modalId = `modal_verify_${interaction.guildId}_${interaction.user.id}_${Date.now()}`;

    // store answer for this modal
    const roleId = verificationRoles.get(interaction.guildId) || null;
    pendingVerifications.set(modalId, {
      answer,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      roleId,
    });

    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle("WERYFIKACJA");

    const answerInput = new TextInputBuilder()
      .setCustomId("verify_answer")
      .setLabel(`Ile to ${expression}?`)
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Wpisz wynik")
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(answerInput));

    await interaction.showModal(modal);
    return;
  }

  // KALKULATOR: ile otrzymam?
  if (customId === "kalkulator_ile_otrzymam") {
    const modal = new ModalBuilder()
      .setCustomId("modal_ile_otrzymam")
      .setTitle("New Shop × Obliczanie");

    const kwotaInput = new TextInputBuilder()
      .setCustomId("kwota")
      .setLabel("Kwota (PLN)")
      .setPlaceholder("np. 50")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(kwotaInput)
    );

    await interaction.showModal(modal);
  }

  // KALKULATOR: ile muszę dać?
  if (customId === "kalkulator_ile_musze_dac") {
    const modal = new ModalBuilder()
      .setCustomId("modal_ile_musze_dac")
      .setTitle("New Shop × Obliczanie");

    const walutaInput = new TextInputBuilder()
      .setCustomId("waluta")
      .setLabel("Ilość waluty (np. 125k / 1m)")
      .setPlaceholder("np. 125k")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(walutaInput)
    );

    await interaction.showModal(modal);
  }

  // Ticket close - double confirmation logic BUT restricted to admins/sellers
  if (customId.startsWith("ticket_close_")) {
    const channel = interaction.channel;
    if (!isTicketChannel(channel)) {
      await interaction.reply({
        content: "❌ Ta komenda działa tylko w kanałach ticketów!",
        ephemeral: true,
      });
      return;
    }

    if (!isAdminOrSeller(interaction.member)) {
      await interaction.reply({
        content: "❌ Tylko administrator lub sprzedawca może zamknąć ticket.",
        ephemeral: true,
      });
      return;
    }

    const chId = channel.id;
    const now = Date.now();
    const pending = pendingTicketClose.get(chId);

    // If there's a pending close and it's by same user and not expired -> proceed
    if (
      pending &&
      pending.userId === interaction.user.id &&
      now - pending.ts < 30_000
    ) {
      pendingTicketClose.delete(chId);
      // remove ticketOwners entry immediately
      const ticketMeta = ticketOwners.get(chId) || null;
      ticketOwners.delete(chId);

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR_BLUE)
            .setDescription("> \`ℹ️\` **Ticket zostanie zamknięty w ciągu 5 sekund...**")
        ]
      });

      // Archive & log immediately, then delete channel shortly after
      try {
        await archiveTicketOnClose(
          channel,
          interaction.user.id,
          ticketMeta,
        ).catch((e) => console.error("archiveTicketOnClose error:", e));
      } catch (e) {
        console.error("Błąd archiwizacji ticketu (button):", e);
      }

      setTimeout(async () => {
        try {
          await channel.delete();
          console.log(`Zamknięto ticket ${channel.name}`);
        } catch (error) {
          console.error("Błąd zamykania ticketu:", error);
        }
      }, 2000);
    } else {
      // set pending note
      pendingTicketClose.set(chId, { userId: interaction.user.id, ts: now });
      await interaction.reply({
        content:
          "> \`⚠️\` **Kliknij ponownie przycisk zamknięcia w ciągu `30` sekund aby potwierdzić __zamknięcie ticketu!__**",
        ephemeral: true,
      });
      // schedule expiry
      setTimeout(() => pendingTicketClose.delete(chId), 30_000);
    }
    return;
  }

  // Redeem code (ticket modal)
  if (customId.startsWith("ticket_code_")) {
    const parts = customId.split("_");
    const ticketChannelId = parts[2];
    const ticketUserId = parts[3];

    if (interaction.user.id !== ticketUserId) {
      await interaction.reply({
        content: "❌ Tylko właściciel ticketu może użyć tego przycisku!",
        ephemeral: true,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`modal_redeem_code_${interaction.channel.id}`)
      .setTitle("Wpisz kod rabatowy");

    const codeInput = new TextInputBuilder()
      .setCustomId("discount_code")
      .setLabel("Wpisz kod który wygrałeś w /drop")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("np. ABC123XYZ0")
      .setRequired(true)
      .setMinLength(10)
      .setMaxLength(10);

    modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
    await interaction.showModal(modal);
    return;
  }

  // Ticket settings button - ONLY admin/seller can use
  if (customId.startsWith("ticket_settings_")) {
    const channel = interaction.channel;
    if (!isTicketChannel(channel)) {
      await interaction.reply({
        content: "❌ Ta funkcja działa tylko w kanałach ticketów!",
        ephemeral: true,
      });
      return;
    }

    // Only administrator or seller can use settings
    if (!isAdminOrSeller(interaction.member)) {
      await interaction.reply({
        content:
          "❌ Tylko administrator lub sprzedawca może zmienić ustawienia tego ticketu.",
        ephemeral: true,
      });
      return;
    }

    // build embed (left stripe + header like screenshot)
    const settingsEmbed = new EmbedBuilder()
      .setColor(COLOR_BLUE)
      .setDescription("⚙️ × **Wybierz akcję z menu poniżej:**");

    // select menu with placeholder like the screenshot
    const select = new StringSelectMenuBuilder()
      .setCustomId(`ticket_settings_select_${channel.id}`)
      .setPlaceholder("❌ × Nie wybrano żadnej z akcji...")
      .addOptions([
        {
          label: "Dodaj osobę",
          value: "add",
          description: "Dodaj użytkownika do ticketu",
        },
        {
          label: "Zmień nazwę kanału",
          value: "rename",
          description: "Zmień nazwę tego ticketu",
        },
        {
          label: "Usuń osobę",
          value: "remove",
          description: "Usuń dostęp użytkownika z ticketu",
        },
      ]);

    const row = new ActionRowBuilder().addComponents(select);

    await interaction.reply({
      embeds: [settingsEmbed],
      components: [row],
      ephemeral: true,
    });
    return;
  }

  // Claiming a ticket via button - ONLY admin or seller
  // Ticket claim/unclaim -> wspólna logika (tak samo jak /przejmij i /odprzejmij)
  if (customId.startsWith("ticket_claim_")) {
    const channelId = customId.replace("ticket_claim_", "");
    await ticketClaimCommon(interaction, channelId);
    return;
  }
  if (customId.startsWith("ticket_unclaim_")) {
    const parts = customId.split("_");
    const channelId = parts[2];
    const expectedClaimer = parts[3] || null;
    await ticketUnclaimCommon(interaction, channelId, expectedClaimer);
    return;
  }
}

async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  switch (commandName) {
    case "drop":
      await handleDropCommand(interaction);
      break;
    case "panelkalkulator":
      await handlePanelKalkulatorCommand(interaction);
      break;
    case "help":
      await handleHelpCommand(interaction);
      break;
    case "opiniekanal":
      await handleOpinieKanalCommand(interaction);
      break;
    case "ticket":
      await handleTicketCommand(interaction);
      break;
    case "ticketpanel":
      await handleTicketPanelCommand(interaction);
      break;
    case "zamknij":
      await handleCloseTicketCommand(interaction);
      break;
    case "panelweryfikacja":
      await handlePanelWeryfikacjaCommand(interaction);
      break;
    case "opinia":
      await handleOpinionCommand(interaction);
      break;
    case "wyczysckanal":
      await handleWyczyscKanalCommand(interaction);
      break;
    case "resetlc":
      await handleResetLCCommand(interaction);
      break;
    case "zresetujczasoczekiwania":
      await handleZresetujCzasCommand(interaction);
      break;
    case "przejmij":
      await handleAdminPrzejmij(interaction);
      break;
    case "odprzejmij":
      await handleAdminOdprzejmij(interaction);
      break;
    case "sendmessage":
      await handleSendMessageCommand(interaction);
      break;
    case "sprawdz-zaproszenia":
      await handleSprawdzZaproszeniaCommand(interaction);
      break;
    case "rozliczenie":
      await handleRozliczenieCommand(interaction);
      break;
    case "rozliczeniezakoncz":
      await handleRozliczenieZakonczCommand(interaction);
      break;
    case "statusbota":
      await handleStatusBotaCommand(interaction);
      break;
    case "rozliczenieustaw":
      await handleRozliczenieUstawCommand(interaction);
      break;
    case "zaproszeniastats":
      await handleZaprosieniaStatsCommand(interaction);
      break;
    case "stworzkonkurs":
      await handleDodajKonkursCommand(interaction);
      break;
  }
}

// Handler dla komendy /rozliczenie
async function handleRozliczenieCommand(interaction) {
  // Sprawdź czy komenda jest używana na właściwym kanale
  if (interaction.channelId !== ROZLICZENIA_CHANNEL_ID) {
    await interaction.reply({
      content: `❌ Ta komenda może być użyta tylko na kanale rozliczeń! <#${ROZLICZENIA_CHANNEL_ID}>`,
      ephemeral: true
    });
    return;
  }

  // Sprawdź czy właściciel lub ma odpowiednią rolę
  const isOwner = interaction.user.id === interaction.guild.ownerId;
  const requiredRoleId = "1350786945944391733";
  const hasRole = interaction.member.roles.cache.has(requiredRoleId);
  
  if (!isOwner && !hasRole) {
    await interaction.reply({
      content: "❌ Tylko właściciel serwera lub użytkownicy z rolą sprzedawcy mogą użyć tej komendy!",
      ephemeral: true
    });
    return;
  }

  const kwota = interaction.options.getInteger("kwota");
  const userId = interaction.user.id;

  if (!weeklySales.has(userId)) {
    weeklySales.set(userId, { amount: 0, lastUpdate: Date.now() });
  }

  const userData = weeklySales.get(userId);
  userData.amount += kwota;
  userData.lastUpdate = Date.now();
  
  // Zapisz stan po dodaniu rozliczenia
  scheduleSavePersistentState();

  const embed = new EmbedBuilder()
    .setColor(COLOR_BLUE)
    .setTitle("\`💱\` Rozliczenie dodane")
    .setDescription(
      `> 👤 **Użytkownik:** <@${userId}>\n` +
      `> \`✅\` × **Dodano sprzedaż:** ${kwota.toLocaleString("pl-PL")} zł\n` +
      `> \`📊\` × **Suma tygodniowa:** ${userData.amount.toLocaleString("pl-PL")} zł\n` +
      `> \`💸\` × **Prowizja do zapłaty (10%):** ${(userData.amount * ROZLICZENIA_PROWIZJA).toLocaleString("pl-PL")} zł\n`,
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  console.log(`Użytkownik ${userId} dodał rozliczenie: ${kwota} zł`);
  
  // Odśwież wiadomość ROZLICZENIA TYGODNIOWE po dodaniu rozliczenia
  setTimeout(sendRozliczeniaMessage, 1000);
}

// Handler dla komendy /rozliczeniezakoncz
async function handleRozliczenieZakonczCommand(interaction) {
  // Sprawdź czy właściciel
  if (interaction.user.id !== interaction.guild.ownerId) {
    await interaction.reply({
      content: "❌ Tylko właściciel serwera może użyć tej komendy!",
      ephemeral: true
    });
    return;
  }

  try {
    const logsChannel = await client.channels.fetch(ROZLICZENIA_LOGS_CHANNEL_ID);
    if (!logsChannel) {
      await interaction.reply({
        content: "❌ Nie znaleziono kanału rozliczeń!",
        ephemeral: true
      });
      return;
    }

    if (weeklySales.size === 0) {
      await interaction.reply({
        content: "❌ Brak rozliczeń w tym tygodniu!",
        ephemeral: true
      });
      return;
    }

    // Zbuduj raport jako embed
    let totalSales = 0;
    let reportLines = [];

    for (const [userId, data] of weeklySales) {
      const prowizja = data.amount * ROZLICZENIA_PROWIZJA;
      // Pobierz nazwę użytkownika zamiast pingować
      const user = client.users.cache.get(userId);
      const userName = user ? user.username : `Użytkownik${userId}`;
      reportLines.push(`${userName} Do zapłaty ${prowizja}zł`);
      totalSales += data.amount;
    }

    const totalProwizja = totalSales * ROZLICZENIA_PROWIZJA;

    const reportEmbed = new EmbedBuilder()
      .setColor(COLOR_BLUE)
      .setTitle("\`📊\` ROZLICZENIA TYGODNIOWE")
      .setDescription(
        reportLines.join('\n') + '\n\n' +
        `> \`📱\` **Przelew na numer:** 880 260 392\n` +
        `> \`⏳\` **Termin płatności:** do 20:00 dnia dzisiejszego\n` +
        `> \`🚫\` **Od teraz do czasu zapłaty nie macie dostępu do ticketów**`
      )
      .setTimestamp()
      .setFooter({ text: "Raport tygodniowy" });

    const sentMessage = await logsChannel.send({ embeds: [reportEmbed] });

    // Zapisz dane przed resetem dla embeda
    const liczbaOsob = weeklySales.size;
    const totalSalesValue = totalSales;
    const totalProwizjaValue = totalProwizja;

    // Resetuj dane po wysłaniu raportu
    weeklySales.clear();
    console.log("Ręcznie zresetowano rozliczenia po /rozliczeniezakoncz");

    const embed = new EmbedBuilder()
      .setColor(COLOR_BLUE)
      .setTitle("✅ Podsumowanie wysłane i zresetowano")
      .setDescription(
        `> \`✅\` × **Wysłano podsumowanie** na kanał <#${ROZLICZENIA_LOGS_CHANNEL_ID}>\n` +
        `> \`🔄\` × **Zresetowano statystyki** na nowy tydzień\n` +
        `> \`📊\` × **Liczba osób:** ${liczbaOsob}\n` +
        `> \`💰\` × **Łączna sprzedaż:** ${totalSalesValue.toLocaleString("pl-PL")} zł\n` +
        `> \`💸\` × **Łączna prowizja:** ${totalProwizjaValue.toLocaleString("pl-PL")} zł`
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
    console.log(`Właściciel ${interaction.user.id} wygenerował podsumowanie rozliczeń`);
  } catch (err) {
    console.error("Błąd generowania podsumowania:", err);
    await interaction.reply({
      content: "❌ Wystąpił błąd podczas generowania podsumowania!",
      ephemeral: true
    });
  }
}

// Handler dla komendy /statusbota
async function handleStatusBotaCommand(interaction) {
  // Sprawdź czy właściciel
  if (interaction.user.id !== interaction.guild.ownerId) {
    await interaction.reply({
      content: "❌ Tylko właściciel serwera może użyć tej komendy!",
      ephemeral: true
    });
    return;
  }

  try {
    const status = await checkBotStatus();
    
    const embed = new EmbedBuilder()
      .setColor(status.statusColor)
      .setTitle("📊 Status Bota")
      .setDescription(`**Status:** ${status.status}`)
      .addFields(
        { name: "⏱ Uptime", value: status.uptime, inline: true },
        { name: "📡 Ping", value: `${status.ping}ms (avg: ${status.avgPing}ms)`, inline: true },
        { name: "🔢 Błędy", value: status.errorCount.toString(), inline: true },
        { name: "🌐 Serwery", value: status.guilds.toString(), inline: true },
        { name: "👥 Użytkownicy", value: status.users.toString(), inline: true },
        { name: "💬 Kanały", value: status.channels.toString(), inline: true }
      )
      .setTimestamp()
      .setFooter({ text: "Bot Monitoring System" });

    await interaction.reply({ embeds: [embed] });
  } catch (err) {
    console.error("Błąd komendy /statusbota:", err);
    await interaction.reply({
      content: "❌ Wystąpił błąd podczas pobierania statusu bota!",
      ephemeral: true
    });
  }
}

// Handler dla komendy /rozliczenieustaw
async function handleRozliczenieUstawCommand(interaction) {
  // Sprawdź czy właściciel
  if (interaction.user.id !== interaction.guild.ownerId) {
    await interaction.reply({
      content: "❌ Tylko właściciel serwera może użyć tej komendy!",
      ephemeral: true
    });
    return;
  }

  const targetUser = interaction.options.getUser("uzytkownik");
  const akcja = interaction.options.getString("akcja");
  const kwota = interaction.options.getInteger("kwota");
  const userId = targetUser.id;

  // Inicjalizuj użytkownika jeśli nie istnieje
  if (!weeklySales.has(userId)) {
    weeklySales.set(userId, { amount: 0, lastUpdate: Date.now() });
  }

  const userData = weeklySales.get(userId);

  if (akcja === "dodaj") {
    userData.amount += kwota;
  } else if (akcja === "odejmij") {
    userData.amount = Math.max(0, userData.amount - kwota);
  } else if (akcja === "ustaw") {
    userData.amount = kwota;
  }

  userData.lastUpdate = Date.now();
  
  // Zapisz stan po zmianie rozliczenia
  scheduleSavePersistentState();

  const prowizja = userData.amount * ROZLICZENIA_PROWIZJA;
  const zmiana = kwota;
  const znakZmiany = akcja === "dodaj" ? "+" : akcja === "odejmij" ? "-" : "";

  const embed = new EmbedBuilder()
    .setColor(0x00ff00)
    .setTitle("✅ Rozliczenie zaktualizowane")
    .setDescription(
      `> \`✅\` × **Zaktualizowano rozliczenie** dla <@${userId}>\n` +
      `> 👤 **Użytkownik:** ${targetUser.username}\n` +
      `> 🔄 **Akcja:** ${akcja.charAt(0).toUpperCase() + akcja.slice(1)}\n` +
      `> 💰 **Kwota zmiany:** ${znakZmiany}${zmiana.toLocaleString("pl-PL")} zł\n` +
      `> 📈 **Nowa suma:** ${userData.amount.toLocaleString("pl-PL")} zł\n` +
      `> 💸 **Prowizja do zapłaty:** ${prowizja.toLocaleString("pl-PL")} zł`
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
  console.log(`Właściciel zaktualizował rozliczenie dla ${userId}: ${akcja} ${kwota} zł`);
}

async function handleAdminPrzejmij(interaction) {
  const channel = interaction.channel;
  if (!isTicketChannel(channel)) {
    await interaction.reply({
      content: "❌ Użyj komendy w kanale ticketu.",
      ephemeral: true,
    });
    return;
  }
  await ticketClaimCommon(interaction, channel.id);
}
async function handlePanelKalkulatorCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "❌ Ta komenda działa tylko na serwerze.",
      ephemeral: true,
    });
    return;
  }

  const member = interaction.member;
  const isAdmin =
    member &&
    member.permissions &&
    (member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild));
  if (!isAdmin) {
    await interaction.reply({
      content: "❌ Nie masz uprawnień administracyjnych.",
      ephemeral: true,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR_BLUE)
    .setDescription(
      "```\n" +
      "🧮 New Shop × Kalkulator\n" +
      "```\n" +
      "> \`ℹ️\` × **Aby w szybki i prosty sposób obliczyć ile otrzymasz waluty za określoną ilość PLN lub ile musisz dać, aby otrzymać określoną ilość waluty, kliknij jeden z przycisków poniżej.**",
    );

  const btnIleOtrzymam = new ButtonBuilder()
    .setCustomId("kalkulator_ile_otrzymam")
    .setLabel("Ile otrzymam?")
    .setStyle(ButtonStyle.Secondary);

  const btnIleMuszeDac = new ButtonBuilder()
    .setCustomId("kalkulator_ile_musze_dac")
    .setLabel("Ile muszę dać?")
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder().addComponents(
    btnIleOtrzymam,
    btnIleMuszeDac,
  );

  await interaction.reply({
    content: "✅ Panel kalkulatora został wysłany na ten kanał.",
    ephemeral: true,
  });

  await interaction.channel.send({ embeds: [embed], components: [row] });
}

async function handleAdminOdprzejmij(interaction) {
  const channel = interaction.channel;
  if (!isTicketChannel(channel)) {
    await interaction.reply({
      content: "❌ Użyj komendy w kanale ticketu.",
      ephemeral: true,
    });
    return;
  }
  await ticketUnclaimCommon(interaction, channel.id, null);
}

/*
  UPDATED: Interactive /sendmessage handler
  Flow:
  - Admin uses /sendmessage [kanal optional]
  - Bot replies ephemeral asking the admin to send the message content in the same channel within 2 minutes.
  - Admin posts the message (can include animated emoji like <a:name:id>, images/GIFs as attachments).
  - Bot forwards the submitted content + attachments + embeds to the target channel as a single EMBED with blue color.
*/
async function handleSendMessageCommand(interaction) {
  // Admin command: interactive sendmessage
  if (!interaction.guild) {
    await interaction.reply({
      content: "❌ Ta komenda działa tylko na serwerze.",
      ephemeral: true,
    });
    return;
  }

  const member = interaction.member;
  const isAdmin =
    member &&
    member.permissions &&
    (member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild));
  if (!isAdmin) {
    await interaction.reply({
      content: "❌ Nie masz uprawnień administracyjnych.",
      ephemeral: true,
    });
    return;
  }

  // Target channel (optional)
  const targetChannel =
    interaction.options.getChannel("kanal") || interaction.channel;

  if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: "❌ Wybierz poprawny kanał tekstowy docelowy.",
      ephemeral: true,
    });
    return;
  }

  // Ask user to send the message they want forwarded
  try {
    await interaction.reply({
      content:
        "✉️ Napisz w tym kanale (w ciągu 2 minut) wiadomość, którą mam wysłać w docelowym kanale.\n" +
        `Docelowy kanał: <#${targetChannel.id}>\n\n` +
        "Możesz wysłać tekst (w tym animowane emoji w formacie `<a:nazwa:id>`), załączyć GIF/obraz, lub wkleić emoji. Wpisz `anuluj`, aby przerwać.",
      ephemeral: true,
    });
  } catch (e) {
    console.error("handleSendMessageCommand: reply failed", e);
    return;
  }

  const collectChannel = interaction.channel;
  if (!collectChannel || !collectChannel.createMessageCollector) {
    await interaction.followUp({
      content:
        "❌ Nie mogę uruchomić kolektora w tym kanale. Spróbuj ponownie.",
      ephemeral: true,
    });
    return;
  }

  const filter = (m) => m.author.id === interaction.user.id && !m.author.bot;
  const collector = collectChannel.createMessageCollector({
    filter,
    time: 120_000,
    max: 1,
  });

  collector.on("collect", async (msg) => {
    const content = (msg.content || "").trim();
    if (content.toLowerCase() === "anuluj") {
      try {
        await interaction.followUp({
          content: "❌ Anulowano wysyłanie wiadomości.",
          ephemeral: true,
        });
      } catch (e) { }
      collector.stop("cancelled");
      return;
    }

    // Prepare files from attachments:
    const files = [];
    let imageAttachment = null;
    for (const att of msg.attachments.values()) {
      if (att.contentType && att.contentType.startsWith('image/')) {
        imageAttachment = att.url;
      } else {
        files.push(att.url);
      }
    }

    // Build embed with blue color to send as the message (user requested)
    const sendEmbed = new EmbedBuilder()
      .setColor(COLOR_BLUE)
      .setDescription(content || "`(brak treści)`")
      .setTimestamp();
    
    // Add image to embed if present
    if (imageAttachment) {
      sendEmbed.setImage(imageAttachment);
    }

    // Forward embeds if the user pasted/embeded some
    const userEmbeds = msg.embeds?.length
      ? msg.embeds.map((e) => e.toJSON())
      : [];

    try {
      // Send to the target channel as embed + attachments (attachments included directly)
      const sendOptions = {
        embeds: [sendEmbed],
        files: files.length ? files : undefined,
      };
      await targetChannel.send(sendOptions);

      // If the user also had embeds, append them as a follow-up (optional)
      if (userEmbeds.length) {
        try {
          await targetChannel.send({ embeds: userEmbeds });
        } catch (e) {
          // ignore
        }
      }

      await interaction.followUp({
        content: `✅ Wiadomość została wysłana do <#${targetChannel.id}>.`,
        ephemeral: true,
      });
    } catch (err) {
      console.error("handleSendMessageCommand: send failed", err);
      try {
        await interaction.followUp({
          content:
            "❌ Nie udało się wysłać wiadomości (sprawdź uprawnienia bota do wysyłania wiadomości/załączników).",
          ephemeral: true,
        });
      } catch (e) { }
    } finally {
      // Optionally delete the user's message to keep the channel clean. Uncomment if desired.
      // try { await msg.delete().catch(()=>null); } catch(e){}
    }
  });

  collector.on("end", async (collected, reason) => {
    if (reason === "time" && collected.size === 0) {
      try {
        await interaction.followUp({
          content:
            "⌛ Nie otrzymałem wiadomości w wyznaczonym czasie. Użyj ponownie /sendmessage aby spróbować jeszcze raz.",
          ephemeral: true,
        });
      } catch (e) { }
    }
  });
}

async function handleDropCommand(interaction) {
  const user = interaction.user;
  const guildId = interaction.guildId;

  // Now require guild and configured drop channel
  if (!guildId) {
    await interaction.reply({
      content: "❌ Ta komenda działa tylko na serwerze!",
      ephemeral: true,
    });
    return;
  }

  const dropChannelId = dropChannels.get(guildId);
  if (!dropChannelId) {
    await interaction.reply({
      content:
        "❌ Kanał drop nie został ustawiony. Administrator może ustawić go manualnie lub utworzyć kanał o nazwie domyślnej.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.channelId !== dropChannelId) {
    await interaction.reply({
      content: `❌ Komendę /drop można użyć tylko na kanale <#${dropChannelId}>`,
      ephemeral: true,
    });
    return;
  }

  // Enforce per-user cooldown for /drop (24h)
  const lastDrop = dropCooldowns.get(user.id) || 0;
  const now = Date.now();
  if (now - lastDrop < DROP_COOLDOWN_MS) {
    const remaining = DROP_COOLDOWN_MS - (now - lastDrop);
    await interaction.reply({
      content: `❌ Możesz użyć /drop ponownie za ${humanizeMs(remaining)}.`,
      ephemeral: true,
    });
    return;
  }

  // reduce drop chances (smaller chance to win)
  const chance = Math.random() * 100;

  let result;
  // Lower probabilities (smaller chance to win)
  if (chance < 0.5) {
    result = { win: true, discount: 10 };
  } else if (chance < 5) {
    result = { win: true, discount: 5 };
  } else {
    result = { win: false };
  }

  // Register use (start cooldown) regardless of win/lose
  dropCooldowns.set(user.id, Date.now());

  // we'll need the channel object to manage the instruction message after replying
  const channel = interaction.channel;

  if (result.win) {
    const code = generateCode();
    const expiryTime = Date.now() + 86400000;
    const expiryTimestamp = Math.floor(expiryTime / 1000);

    activeCodes.set(code, {
      oderId: user.id,
      discount: result.discount,
      expiresAt: expiryTime,
      used: false,
      type: "discount",
    });

    setTimeout(() => {
      activeCodes.delete(code);
    }, 86400000);

    const winEmbed = new EmbedBuilder()
      .setColor(0xd4af37) // yellow for win
      .setDescription(
        "```\n" +
        "🎀 New Shop × DROP\n" +
        "```\n" +
        `\`👤\` × **Użytkownik:** ${user}\n` +
        `\`🎉\` × **Gratulacje! Udało ci się wylosować -${result.discount}% na zakupy w naszym sklepie!**\n` +
        `\`⏰\` × **Zniżka wygasa:** <t:${expiryTimestamp}:R>\n\n` +
        `📩 **Sprawdź prywatne wiadomości po kod!**`,
      )
      .setTimestamp();

    const dmEmbed = new EmbedBuilder()
      .setColor(0xd4af37)
      .setTitle("\`🔑\` Twój kod rabatowy")
      .setDescription(
        "```\n" +
        code +
        "\n```\n" +
        `> \`💸\` × **Otrzymałeś:** \`-${result.discount}%\`\n` +
        `> \`🕑\` × **Kod wygaśnie za:** <t:${expiryTimestamp}:R> \n\n` +
        `> \`❔\` × Aby zrealizować kod utwórz nowy ticket, wybierz kategorię\n` +
        `> \`Zakup\` i kliknij przycisk \`Kod rabatowy\``,
      )
      .setTimestamp();

    try {
      await user.send({ embeds: [dmEmbed] });
      await interaction.reply({ embeds: [winEmbed] });
    } catch (error) {
      const winEmbedWithCode = new EmbedBuilder()
        .setColor(COLOR_YELLOW)
        .setDescription(
          "```\n" +
          "🎀 New Shop × DROP\n" +
          "```\n" +
          `\`👤\` × **Użytkownik:** ${user}\n` +
          `\`🎉\` × **Gratulacje! Udało ci się wylosować -${result.discount}% na zakupy w sklepie!**\n` +
          `\`🔑\` × **Twój kod:** ||\`${code}\`|| (kliknij aby odkryć)\n` +
          `\`⏰\` × **Zniżka wygasa:** <t:${expiryTimestamp}:R>`,
        )
        .setTimestamp();
      await interaction.reply({ embeds: [winEmbedWithCode], ephemeral: true });
    }
  } else {
    const loseEmbed = new EmbedBuilder()
      .setColor(COLOR_GRAY) // gray for lose
      .setDescription(
        "```\n" +
        "🎀 New Shop × DROP\n" +
        "```\n" +
        `\`👤\` × **Użytkownik:** ${user}\n` +
        `\`😢\` × **Niestety, tym razem nie udało się! Spróbuj ponownie później...**`,
      )
      .setTimestamp();

    await interaction.reply({ embeds: [loseEmbed] });
  }

  // Manage drop instruction message: delete previous and send a fresh one so it moves to the bottom
  try {
    if (channel && channel.id) {
      // delete previous instruction if present
      const prevInstrId = lastDropInstruction.get(channel.id);
      if (prevInstrId) {
        try {
          const prevMsg = await channel.messages
            .fetch(prevInstrId)
            .catch(() => null);
          if (prevMsg && prevMsg.deletable) {
            await prevMsg.delete().catch(() => null);
          }
        } catch (err) {
          // ignore
        }
        lastDropInstruction.delete(channel.id);
      }

      // send new instruction embed
      const instructionDropEmbed = new EmbedBuilder()
        .setColor(COLOR_YELLOW)
        .setDescription(
          "`🎁` Użyj komendy </drop:1454974442370240585>, aby wylosować zniżkę na zakupy!",
        );

      try {
        const sent = await channel.send({ embeds: [instructionDropEmbed] });
        lastDropInstruction.set(channel.id, sent.id);
      } catch (err) {
        // ignore (no perms)
      }
    }
  } catch (e) {
    console.error("Błąd zarządzania instrukcją drop:", e);
  }
}

async function handleOpinieKanalCommand(interaction) {
  const channel = interaction.options.getChannel("kanal");
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "❌ Ta komenda działa tylko na serwerze!",
      ephemeral: true,
    });
    return;
  }

  opinieChannels.set(guildId, channel.id);
  await interaction.reply({
    content: `✅ Kanał opinii ustawiony na <#${channel.id}>`,
    ephemeral: true,
  });
  console.log(`Kanał opinii ustawiony na ${channel.id} dla serwera ${guildId}`);
}

async function handlePanelWeryfikacjaCommand(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "❌ Ta komenda działa tylko na serwerze!",
      ephemeral: true,
    });
    return;
  }

  const roleId = "1425935544273338532";
  // lokalna ścieżka do pliku GIF w folderze attached_assets
  const gifPath = path.join(
    __dirname,
    "attached_assets",
    "standard_(1)_1766946611653.gif",
  );
  let attachment = null;

  try {
    // dołączamy plik i nadajemy mu prostą nazwę, której użyjemy w embed (attachment://standard_1.gif)
    attachment = new AttachmentBuilder(gifPath, { name: "standard_1.gif" });
  } catch (err) {
    console.warn("Nie udało się załadować lokalnego GIFa:", err);
    attachment = null;
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR_BLUE)
    .setDescription(
      "```\n" +
      "🛒 New Shop × WERYFIKACJA\n" +
      "```\n" +
      `> Przejdź prostą zagadkę matematyczną\n` +
      `> aby otrzymać rolę **klient.**`,
    )
    // jeśli plik lokalny załadowany - użyj attachment://..., w przeciwnym wypadku fallback na zdalny URL
    .setImage(
      attachment
        ? "attachment://standard_1.gif"
        : "https://cdn.discordapp.com/attachments/1449367698374004869/1450192787894046751/standard_1.gif",
    );

  const button = new ButtonBuilder()
    .setCustomId(`verify_panel_${interaction.channelId}_${Date.now()}`)
    .setStyle(ButtonStyle.Primary) // niebieski
    .setEmoji("📝");

  const row = new ActionRowBuilder().addComponents(button);

  try {
    // Defer reply na początku, aby uniknąć Unknown interaction
    await interaction.deferReply({ ephemeral: true });

    const sendOptions = {
      embeds: [embed],
      components: [row],
      allowedMentions: { roles: [roleId] },
    };
    if (attachment) sendOptions.files = [attachment];

    await interaction.channel.send(sendOptions);

    await interaction.editReply({
      content: "✅ Panel weryfikacji wysłany na ten kanał.",
    });
    console.log(
      `Wysłano panel weryfikacji na kanale ${interaction.channelId} (serwer ${guildId})`,
    );
  } catch (err) {
    console.error("Błąd wysyłania panelu weryfikacji:", err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({
          content:
            "❌ Nie udało się wysłać panelu weryfikacji (sprawdź uprawnienia lub ścieżkę do pliku).",
        });
      } else {
        await interaction.reply({
          content:
            "❌ Nie udało się wysłać panelu weryfikacji (sprawdź uprawnienia lub ścieżkę do pliku).",
          ephemeral: true,
        });
      }
    } catch (e) {
      // ignore
    }
  }
}

async function handleTicketCommand(interaction) {
  const botName = client.user?.username || "NEWSHOP";

  const embed = new EmbedBuilder()
    .setColor(COLOR_BLUE)
    .setDescription(
      "```\n" +
      "🛒 New Shop × TICKET\n" +
      "```\n" +
      `📦 × Wybierz odpowiednią kategorię, aby utworzyć ticketa!`,
    );

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("ticket_category")
    .setPlaceholder("Wybierz kategorię...")
    .addOptions([
      {
        label: "💰 Zakup",
        value: "zakup",
        description: "Chcę kupić przedmioty",
      },
      {
        label: "💵 Sprzedaż",
        value: "sprzedaz",
        description: "Chcę sprzedać przedmioty",
      },
      {
        label: "🎁 Nagroda za zaproszenia",
        value: "odbior",
        description: "Odbiór nagrody za zaproszenia (kod)",
      },
      {
        label: "🏆 Nagroda za konkurs",
        value: "konkurs_odbior",
        description: "Odbiór nagrody za konkurs",
      },
      { label: "❓ Inne", value: "inne", description: "Inna sprawa" },
    ]);

  const row = new ActionRowBuilder().addComponents(selectMenu);

  await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true,
  });
}

async function handleTicketPanelCommand(interaction) {
  const botName = client.user?.username || "NEWSHOP";

  const embed = new EmbedBuilder()
    .setColor(COLOR_BLUE)
    .setDescription(
      "```\n" +
      "🛒 New Shop × TICKET\n" +
      "```\n" +
      "`📩` × Wybierz odpowiednią kategorię, aby utworzyć ticketa!",
    );

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("ticket_category")
    .setPlaceholder("Wybierz kategorię...")
    .addOptions([
      {
        label: "💰 Zakup",
        value: "zakup",
        description: "Kliknij, aby dokonać zakupu!",
      },
      {
        label: "💵 Sprzedaż",
        value: "sprzedaz",
        description: "Kliknij, aby dokonać sprzedaży!",
      },
      {
        label: "🎁 Nagroda za zaproszenia",
        value: "odbior",
        description: "Kliknij, aby odebrać nagrode za zaproszenia (kod)",
      },
      {
        label: "🏆 Nagroda za konkurs",
        value: "konkurs_odbior",
        description: "Kliknij, aby odebrać nagrode za konkurs",
      },
      { label: "❓ Pytanie", value: "inne", description: "Kliknij, aby zadać pytanie!" },
    ]);

  const row = new ActionRowBuilder().addComponents(selectMenu);

  await interaction.reply({
    content: "✅ Panel ticketów wysłany!",
    ephemeral: true,
  });

  await interaction.channel.send({ embeds: [embed], components: [row] });
}

async function handleCloseTicketCommand(interaction) {
  const channel = interaction.channel;

  if (!isTicketChannel(channel)) {
    await interaction.reply({
      content: "❌ Ta komenda działa tylko w kanałach ticketów!",
      ephemeral: true,
    });
    return;
  }

  // only admins / sellers
  if (!isAdminOrSeller(interaction.member)) {
    await interaction.reply({
      content: "❌ Tylko administrator lub sprzedawca może zamknąć ticket.",
      ephemeral: true,
    });
    return;
  }

  const chId = channel.id;
  const now = Date.now();
  const pending = pendingTicketClose.get(chId);

  if (
    pending &&
    pending.userId === interaction.user.id &&
    now - pending.ts < 30_000
  ) {
    pendingTicketClose.delete(chId);
    // remove ticketOwners entry immediately
    const ticketMeta = ticketOwners.get(chId) || null;
    ticketOwners.delete(chId);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR_BLUE)
          .setDescription("> \`ℹ️\` **Ticket zostanie zamknięty w ciągu 5 sekund...**")
      ]
    });

    try {
      await archiveTicketOnClose(
        channel,
        interaction.user.id,
        ticketMeta,
      ).catch((e) => console.error("archiveTicketOnClose error:", e));
    } catch (e) {
      console.error("Błąd archiwizacji ticketu (command):", e);
    }

    setTimeout(async () => {
      try {
        await channel.delete();
      } catch (error) {
        console.error("Błąd zamykania ticketu:", error);
      }
    }, 2000);
  } else {
    pendingTicketClose.set(chId, { userId: interaction.user.id, ts: now });
    await interaction.reply({
      content:
        "⚠️ Kliknij /zamknij ponownie w ciągu 30 sekund, aby potwierdzić zamknięcie ticketu.",
      ephemeral: true,
    });
    setTimeout(() => pendingTicketClose.delete(chId), 30_000);
  }
}

async function handleSelectMenu(interaction) {
  // KALKULATOR select menu handlers
  if (interaction.customId === "kalkulator_tryb" || interaction.customId === "kalkulator_metoda") {
    await handleKalkulatorSelect(interaction);
    return;
  }

  // ticket category menu
  if (interaction.customId === "ticket_category") {
    const selectedCategory = interaction.values[0];

    switch (selectedCategory) {
      case "zakup":
        await showZakupModal(interaction);
        break;
      case "sprzedaz":
        await showSprzedazModal(interaction);
        break;
      case "odbior":
        await showOdbiorModal(interaction);
        break;
      case "konkurs_odbior":
        await showKonkursOdbiorModal(interaction);
        break;
      case "inne":
        await showInneModal(interaction);
        break;
      default:
        await interaction.reply({
          content: "❌ × Nie wybrano żadnej z kategorii!",
          ephemeral: true,
        });
    }
    return;
  }

  // ticket settings select handler
  if (interaction.customId.startsWith("ticket_settings_select_")) {
    const channelId = interaction.customId.replace(
      "ticket_settings_select_",
      "",
    );
    const chosen = interaction.values[0];

    // handle chosen action: open modal accordingly
    if (chosen === "rename") {
      const modal = new ModalBuilder()
        .setCustomId(`modal_rename_${channelId}`)
        .setTitle("Zmień nazwę ticketu");

      const nameInput = new TextInputBuilder()
        .setCustomId("new_ticket_name")
        .setLabel("Nowa nazwa kanału (np. ticket-nick)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("ticket-nick")
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(90);

      modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
      await interaction.showModal(modal);
      return;
    }

    if (chosen === "add") {
      const modal = new ModalBuilder()
        .setCustomId(`modal_add_${channelId}`)
        .setTitle("Dodaj użytkownika do ticketu");

      const userInput = new TextInputBuilder()
        .setCustomId("user_to_add")
        .setLabel("Wpisz @mention lub ID użytkownika")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("@użytkownik lub ID")
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(userInput));
      await interaction.showModal(modal);
      return;
    }

    if (chosen === "remove") {
      const modal = new ModalBuilder()
        .setCustomId(`modal_remove_${channelId}`)
        .setTitle("Usuń użytkownika z ticketu");

      const userInput = new TextInputBuilder()
        .setCustomId("user_to_remove")
        .setLabel("Wpisz @mention lub ID użytkownika")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("@użytkownik lub ID")
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(userInput));
      await interaction.showModal(modal);
      return;
    }

    await interaction.reply({ content: "❌ Nieznana akcja.", ephemeral: true });
    return;
  }
}

async function showZakupModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId("modal_zakup")
    .setTitle("Informacje dot. zakupu.");

  const serwerInput = new TextInputBuilder()
    .setCustomId("serwer")
    .setLabel("Na jakim serwerze?")
    .setPlaceholder("Anarchia, Rapy itd.")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const kwotaInput = new TextInputBuilder()
    .setCustomId("kwota")
    .setLabel("Za ile chcesz kupić? (tylko liczba, np. 40)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("np. 40")
    .setRequired(true);

  const platnosInput = new TextInputBuilder()
    .setCustomId("platnosc")
    .setLabel("Jaką metodą płatności płacisz?")
    .setPlaceholder("PayPal, BLIK, Przelew, PaySafeCard (...)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const oczekiwanaWalutaInput = new TextInputBuilder()
    .setCustomId("oczekiwana_waluta")
    .setLabel("Co chciałbyś zakupić")
    .setPlaceholder("np. Elytra")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(serwerInput),
    new ActionRowBuilder().addComponents(kwotaInput),
    new ActionRowBuilder().addComponents(platnosInput),
    new ActionRowBuilder().addComponents(oczekiwanaWalutaInput),
  );

  await interaction.showModal(modal);
}

async function showKonkursOdbiorModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId("modal_konkurs_odbior")
    .setTitle("Nagroda za konkurs");

  const infoInput = new TextInputBuilder()
    .setCustomId("konkurs_info")
    .setLabel("Za jaki konkurs / jaka nagroda?")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("np. konkurs na discordzie / 100k$")
    .setRequired(true)
    .setMaxLength(128);

  modal.addComponents(new ActionRowBuilder().addComponents(infoInput));

  await interaction.showModal(modal);
}

async function ticketClaimCommon(interaction, channelId) {
  const isBtn = typeof interaction.isButton === "function" && interaction.isButton();

  if (!isAdminOrSeller(interaction.member)) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Tylko administrator lub sprzedawca może przejąć ticket.",
        ephemeral: true,
      });
    } else {
      await interaction.followUp({
        content: "❌ Tylko administrator lub sprzedawca może przejąć ticket.",
        ephemeral: true,
      }).catch(() => null);
    }
    return;
  }

  if (!interaction.replied && !interaction.deferred) {
    if (isBtn) {
      await interaction.deferUpdate().catch(() => null);
    } else {
      await interaction.deferReply({ ephemeral: true }).catch(() => null);
    }
  }

  const replyEphemeral = async (text) => {
    if (isBtn) {
      await interaction.followUp({ content: text, ephemeral: true }).catch(() => null);
    } else {
      await interaction.editReply({ content: text }).catch(() => null);
    }
  };

  const ticketData = ticketOwners.get(channelId) || {
    claimedBy: null,
    locked: false,
    userId: null,
    ticketMessageId: null,
    originalCategoryId: null, // Zapisz oryginalną kategorię
  };

  if (ticketData.locked) {
    await replyEphemeral(
      "❌ Ten ticket został zablokowany do przejmowania (ustawienia/zmiana nazwy).",
    );
    return;
  }

  if (ticketData && ticketData.claimedBy) {
    await replyEphemeral(
      `❌ Ten ticket został już przejęty przez <@${ticketData.claimedBy}>!`,
    );
    return;
  }

  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch) {
    await replyEphemeral("❌ Nie mogę znaleźć tego kanału.");
    return;
  }

  try {
    const claimerId = interaction.user.id;

    // Zapisz oryginalną kategorię przed przeniesieniem
    if (!ticketData.originalCategoryId) {
      ticketData.originalCategoryId = ch.parentId;
    }

    // Przenieś do kategorii TICKETY PRZEJĘTE
    const przejetaKategoriaId = "1457446529395593338";
    const przejetaKategoria = await client.channels.fetch(przejetaKategoriaId).catch(() => null);
    
    if (przejetaKategoria) {
      await ch.setParent(przejetaKategoriaId).catch((err) => {
        console.error("Błąd przenoszenia do kategorii TICKETY PRZEJĘTE:", err);
      });
      console.log(`Przeniesiono ticket ${channelId} do kategorii TICKETY PRZEJĘTE`);
    } else {
      console.error("Nie znaleziono kategorii TICKETY PRZEJĘTE (1457446529395593338)");
    }

    // Ustaw uprawnienia dla osoby przejmującej + właściciela ticketu
    const permissionOverwrites = [
      {
        id: claimerId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
      },
      {
        id: interaction.guild.roles.everyone,
        deny: [PermissionFlagsBits.ViewChannel] // @everyone nie widzi gdy ktoś przejmie
      }
    ];

    // Dodaj właściciela ticketu do uprawnień
    if (ticketData && ticketData.userId) {
      permissionOverwrites.push({
        id: ticketData.userId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
      });
    }

    await ch.permissionOverwrites.set(permissionOverwrites);

    // Usuń limity kategorii dla kanału
    const limitCategories = [
      "1449448705563557918", // limit 20
      "1449448702925209651", // limit 50
      "1449448686156255333", // limit 100
      "1449448860517798061"  // limit 200
    ];

    for (const categoryId of limitCategories) {
      const category = await client.channels.fetch(categoryId).catch(() => null);
      if (category && category.type === ChannelType.GuildCategory) {
        await category.permissionOverwrites.edit(ch.id, {
          ViewChannel: false,
          SendMessages: false,
          ReadMessageHistory: false
        }).catch(() => null);
      }
    }

    // Właściciel ticketu już ma dostęp - nie trzeba nic zmieniać
    // Usuń limity kategorii dla kanału

    ticketData.claimedBy = claimerId;
    ticketOwners.set(channelId, ticketData);

    if (ticketData && ticketData.ticketMessageId) {
      await editTicketMessageButtons(ch, ticketData.ticketMessageId, claimerId).catch(() => null);
    }

    const publicEmbed = new EmbedBuilder()
      .setColor(COLOR_BLUE)
      .setDescription(`> \`✅\` × Ticket został przejęty przez <@${claimerId}>`);

    await ch.send({ embeds: [publicEmbed] }).catch(() => null);
    if (!isBtn) {
      await interaction.deleteReply().catch(() => null);
    }
  } catch (err) {
    console.error("Błąd przy przejmowaniu ticketu:", err);
    await replyEphemeral("❌ Wystąpił błąd podczas przejmowania ticketu.");
  }
}

async function ticketUnclaimCommon(interaction, channelId, expectedClaimer = null) {
  const isBtn = typeof interaction.isButton === "function" && interaction.isButton();

  if (!isAdminOrSeller(interaction.member)) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Tylko administrator lub sprzedawca może oddać ticket.",
        ephemeral: true,
      });
    } else {
      await interaction.followUp({
        content: "❌ Tylko administrator lub sprzedawca może oddać ticket.",
        ephemeral: true,
      }).catch(() => null);
    }
    return;
  }

  if (!interaction.replied && !interaction.deferred) {
    if (isBtn) {
      await interaction.deferUpdate().catch(() => null);
    } else {
      await interaction.deferReply({ ephemeral: true }).catch(() => null);
    }
  }

  const replyEphemeral = async (text) => {
    if (isBtn) {
      await interaction.followUp({ content: text, ephemeral: true }).catch(() => null);
    } else {
      await interaction.editReply({ content: text }).catch(() => null);
    }
  };

  const ticketData = ticketOwners.get(channelId) || {
    claimedBy: null,
    userId: null,
    ticketMessageId: null,
    originalCategoryId: null, // Dodaj oryginalną kategorię
  };

  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch) {
    await replyEphemeral("❌ Nie mogę znaleźć tego kanału.");
    return;
  }

  if (!ticketData.claimedBy) {
    await replyEphemeral("ℹ️ Ten ticket nie jest przejęty.");
    return;
  }

  if (
    expectedClaimer &&
    expectedClaimer !== interaction.user.id &&
    !isAdminOrSeller(interaction.member)
  ) {
    await replyEphemeral(
      "❌ Tylko osoba, która przejęła ticket (lub admin/seller) może użyć tego przycisku.",
    );
    return;
  }

  try {
    const releaserId = interaction.user.id;

    // Przywróć oryginalną kategorię jeśli istnieje
    if (ticketData.originalCategoryId) {
      const originalCategory = await client.channels.fetch(ticketData.originalCategoryId).catch(() => null);
      
      if (originalCategory) {
        await ch.setParent(ticketData.originalCategoryId).catch((err) => {
          console.error("Błąd przywracania oryginalnej kategorii:", err);
        });
        console.log(`Przywrócono ticket ${channelId} do oryginalnej kategorii ${ticketData.originalCategoryId}`);
      } else {
        console.error("Nie znaleziono oryginalnej kategorii:", ticketData.originalCategoryId);
      }
    }

    // Przywróć uprawnienia w zależności od oryginalnej kategorii
    if (ticketData.originalCategoryId) {
      const categoryId = ticketData.originalCategoryId;
      
      // Zakup 0-20 - wszystkie rangi widzą
      if (categoryId === "1449526840942268526") {
        await ch.permissionOverwrites.set([
          { id: interaction.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: "1449448705563557918", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 20
          { id: "1449448702925209651", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 50
          { id: "1449448686156255333", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 100
          { id: "1449448860517798061", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }  // limit 200
        ]);
      }
      // Zakup 20-50 - limit 20 nie widzi
      else if (categoryId === "1449526958508474409") {
        await ch.permissionOverwrites.set([
          { id: interaction.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: "1449448702925209651", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 50
          { id: "1449448686156255333", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 100
          { id: "1449448860517798061", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }  // limit 200
        ]);
      }
      // Zakup 50-100 - limit 20 i 50 nie widzą
      else if (categoryId === "1449451716129984595") {
        await ch.permissionOverwrites.set([
          { id: interaction.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: "1449448686156255333", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 100
          { id: "1449448860517798061", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }  // limit 200
        ]);
      }
      // Zakup 100-200 - tylko limit 200 widzi
      else if (categoryId === "1449452354201190485") {
        await ch.permissionOverwrites.set([
          { id: interaction.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: "1449448860517798061", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }  // limit 200
        ]);
      }
      // Sprzedaż - wszystkie rangi widzą
      else if (categoryId === "1449455848043708426") {
        await ch.permissionOverwrites.set([
          { id: interaction.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: "1449448705563557918", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 20
          { id: "1449448702925209651", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 50
          { id: "1449448686156255333", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 100
          { id: "1449448860517798061", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }  // limit 200
        ]);
      }
      // Inne - wszystkie rangi widzą
      else if (categoryId === "1449527585271976131") {
        await ch.permissionOverwrites.set([
          { id: interaction.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: "1449448705563557918", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 20
          { id: "1449448702925209651", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 50
          { id: "1449448686156255333", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 100
          { id: "1449448860517798061", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }  // limit 200
        ]);
      }
    }

    // Przywróć dostęp właścicielowi ticketu - zawsze musi widzieć
    if (ticketData && ticketData.userId) {
      await ch.permissionOverwrites.edit(ticketData.userId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      }).catch(() => null);
    }

    // Usuń uprawnienia osoby przejmującej
    if (ticketData.claimedBy) {
      await ch.permissionOverwrites.delete(ticketData.claimedBy).catch(() => null);
    }

    ticketData.claimedBy = null;
    ticketOwners.set(channelId, ticketData);

    if (ticketData.ticketMessageId) {
      await editTicketMessageButtons(ch, ticketData.ticketMessageId, null).catch(() => null);
    }

    const publicEmbed = new EmbedBuilder()
      .setColor(COLOR_BLUE)
      .setDescription(`> \`🔓\` × Ticket został zwolniony przez <@${releaserId}>`);

    await ch.send({ embeds: [publicEmbed] }).catch(() => null);
    if (!isBtn) {
      await interaction.deleteReply().catch(() => null);
    }
  } catch (err) {
    console.error("Błąd przy unclaim:", err);
    await replyEphemeral("❌ Wystąpił błąd podczas odprzejmowania ticketu.");
  }
}

async function showSprzedazModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId("modal_sprzedaz")
    .setTitle("Informacje dot. zgłoszenia.");

  const coInput = new TextInputBuilder()
    .setCustomId("co_sprzedac")
    .setLabel("Co chcesz sprzedać?")
    .setPlaceholder("100k$, rapy box itd.")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const serwerInput = new TextInputBuilder()
    .setCustomId("serwer")
    .setLabel("Na jakim serwerze?")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Anarchia, Rapy itd.")
    .setRequired(true);

  const ileInput = new TextInputBuilder()
    .setCustomId("ile")
    .setLabel("Ile oczekujesz?")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("np. 20zł")
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(coInput),
    new ActionRowBuilder().addComponents(serwerInput),
    new ActionRowBuilder().addComponents(ileInput),
  );

  await interaction.showModal(modal);
}

async function showOdbiorModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId("modal_odbior")
    .setTitle("Nagroda za zaproszenia");

  const codeInput = new TextInputBuilder()
    .setCustomId("reward_code")
    .setLabel("Wpisz kod aby odberać nagrode!")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Tutaj wpisz kod który otrzymałeś na pv")
    .setRequired(true)
    .setMaxLength(64);

  modal.addComponents(new ActionRowBuilder().addComponents(codeInput));

  await interaction.showModal(modal);
}

async function showInneModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId("modal_inne")
    .setTitle("Informacje dot. zgłoszenia.");

  const sprawaInput = new TextInputBuilder()
    .setCustomId("sprawa")
    .setLabel("W jakiej sprawie robisz ticketa?")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(256)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(sprawaInput));

  await interaction.showModal(modal);
}

async function handleModalSubmit(interaction) {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) return;

  const botName = client.user?.username || "NEWSHOP";

  // NEW: konkurs create modal
  if (interaction.customId === "konkurs_create_modal") {
    await handleKonkursCreateModal(interaction);
    return;
  }
  // KALKULATOR: ile otrzymam?
  if (interaction.customId === "modal_ile_otrzymam") {
    try {
      const kwotaStr = interaction.fields.getTextInputValue("kwota");
      const kwota = parseFloat(kwotaStr.replace(",", "."));

      if (isNaN(kwota) || kwota <= 0) {
        await interaction.reply({
          content: "❌ Podaj poprawną kwotę w PLN.",
          ephemeral: true,
        });
        return;
      }

      // Zapisz kwotę i pokaż menu z wyborem trybu i metody
      const userId = interaction.user.id;
      kalkulatorData.set(userId, { kwota, typ: "otrzymam" });

      const trybSelect = new StringSelectMenuBuilder()
        .setCustomId("kalkulator_tryb")
        .setPlaceholder("Wybierz serwer...")
        .addOptions(
          { label: "ANARCHIA LIFESTEAL", value: "ANARCHIA_LIFESTEAL", emoji: { id: "1457109250949124258" } },
          { label: "ANARCHIA BOXPVP", value: "ANARCHIA_BOXPVP", emoji: { id: "1457109250949124258" } },
          { label: "PYK MC", value: "PYK_MC", emoji: { id: "1457113144412475635" } }
        );

      const metodaSelect = new StringSelectMenuBuilder()
        .setCustomId("kalkulator_metoda")
        .setPlaceholder("Wybierz metodę płatności...")
        .addOptions(
          { label: "BLIK", value: "BLIK", description: "Szybki przelew BLIK (0% prowizji)", emoji: { id: "1449354065887756378" } },
          { label: "Kod BLIK", value: "Kod BLIK", description: "Kod BLIK (10% prowizji)", emoji: { id: "1449354065887756378" } },
          { label: "PSC", value: "PSC", description: "Paysafecard (10% prowizji)", emoji: { id: "1449352743591608422" } },
          { label: "PSC bez paragonu", value: "PSC bez paragonu", description: "Paysafecard bez paragonu (20% prowizji)", emoji: { id: "1449352743591608422" } },
          { label: "PayPal", value: "PayPal", description: "PayPal (5% prowizji)", emoji: { id: "1449354427755659444" } },
          { label: "LTC", value: "LTC", description: "Litecoin (5% prowizji)", emoji: { id: "1449186363101548677" } }
        );

      const embed = new EmbedBuilder()
        .setColor(COLOR_BLUE)
        .setDescription(
          "```\n" +
          "🔢 New Shop × Obliczanie\n" +
          "```\n" +
          `> \`💵\` × **Wybrana kwota:** \`${kwota.toFixed(2)}zł\`\n> \`❗\` × Wybierz serwer i metodę płatności __poniżej:__`);

      await interaction.reply({
        embeds: [embed],
        components: [
          new ActionRowBuilder().addComponents(trybSelect),
          new ActionRowBuilder().addComponents(metodaSelect)
        ],
        ephemeral: true
      });
    } catch (error) {
      console.error("Błąd w modal_ile_otrzymam:", error);
      await interaction.reply({
        content: "❌ Wystąpił błąd podczas przetwarzania. Spróbuj ponownie.",
        ephemeral: true
      });
    }
    return;
  }

  // KALKULATOR: ile muszę dać?
  if (interaction.customId === "modal_ile_musze_dac") {
    try {
      const walutaStr = interaction.fields.getTextInputValue("waluta");
      const waluta = parseShortNumber(walutaStr);

      if (!waluta || waluta <= 0 || waluta > 999_000_000) {
        await interaction.reply({
          content: "❌ Podaj poprawną ilość waluty (1–999 000 000, możesz użyć k/m).",
          ephemeral: true,
        });
        return;
      }

      // Zapisz walutę i pokaż menu z wyborem trybu i metody
      const userId = interaction.user.id;
      kalkulatorData.set(userId, { waluta, typ: "muszedac" });

      const trybSelect = new StringSelectMenuBuilder()
        .setCustomId("kalkulator_tryb")
        .setPlaceholder("Wybierz serwer...")
        .addOptions(
          { label: "ANARCHIA LIFESTEAL", value: "ANARCHIA_LIFESTEAL", emoji: { id: "1457109250949124258" } },
          { label: "ANARCHIA BOXPVP", value: "ANARCHIA_BOXPVP", emoji: { id: "1457109250949124258" } },
          { label: "PYK MC", value: "PYK_MC", emoji: { id: "1457113144412475635" } }
        );

      const metodaSelect = new StringSelectMenuBuilder()
        .setCustomId("kalkulator_metoda")
        .setPlaceholder("Wybierz metodę płatności...")
        .addOptions(
          { label: "BLIK", value: "BLIK", description: "Szybki przelew BLIK (0% prowizji)", emoji: { id: "1449354065887756378" } },
          { label: "Kod BLIK", value: "Kod BLIK", description: "Kod BLIK (10% prowizji)", emoji: { id: "1449354065887756378" } },
          { label: "PSC", value: "PSC", description: "Paysafecard (10% prowizji)", emoji: { id: "1449352743591608422" } },
          { label: "PSC bez paragonu", value: "PSC bez paragonu", description: "Paysafecard bez paragonu (20% prowizji)", emoji: { id: "1449352743591608422" } },
          { label: "PayPal", value: "PayPal", description: "PayPal (5% prowizji)", emoji: { id: "1449354427755659444" } },
          { label: "LTC", value: "LTC", description: "Litecoin (5% prowizji)", emoji: { id: "1449186363101548677" } }
        );

      const embed = new EmbedBuilder()
        .setColor(COLOR_BLUE)
        .setDescription(
          "```\n" +
          "🔢 New Shop × Obliczanie\n" +
          "```\n" +
          `> \`💲\` × **Wybrana ilość waluty:** \`${formatShortWaluta(waluta)}\`\n> \`❗\` × Wybierz serwer i metodę płatności __poniżej:__`);

      await interaction.reply({
        embeds: [embed],
        components: [
          new ActionRowBuilder().addComponents(trybSelect),
          new ActionRowBuilder().addComponents(metodaSelect)
        ],
        ephemeral: true
      });
    } catch (error) {
      console.error("Błąd w modal_ile_musze_dac:", error);
      await interaction.reply({
        content: "> \`❌\` **Wystąpił błąd podczas przetwarzania. Spróbuj ponownie.**",
        ephemeral: true
      });
    }
    return;
  }

  // NEW: konkurs join modal
  if (interaction.customId.startsWith("konkurs_join_modal_")) {
    const msgId = interaction.customId.replace("konkurs_join_modal_", "");
    await handleKonkursJoinModal(interaction, msgId);
    return;
  }

  // NEW: verification modal handling
  if (interaction.customId.startsWith("modal_verify_")) {
    const modalId = interaction.customId;
    const record = pendingVerifications.get(modalId);

    if (!record) {
      await interaction.reply({
        content:
          "> \`❌\` **Nie mogę znaleźć zapisanego zadania weryfikacji (spróbuj ponownie).**",
        ephemeral: true,
      });
      return;
    }

    if (record.userId !== interaction.user.id) {
      await interaction.reply({
        content:
          "> \`❌\` **Tylko użytkownik, który kliknął przycisk, może rozwiązać tę zagadkę.**",
        ephemeral: true,
      });
      return;
    }

    const entered = interaction.fields
      .getTextInputValue("verify_answer")
      .trim();
    const numeric = parseInt(entered.replace(/[^0-9\-]/g, ""), 10);

    if (Number.isNaN(numeric)) {
      await interaction.reply({
        content: "\`❌\` **Nieprawidłowa odpowiedź (powinna być liczbą).**",
        ephemeral: true,
      });
      return;
    }

    if (numeric !== record.answer) {
      await interaction.reply({
        content: "> \`❌\` **Źle! Nieprawidłowy wynik. Spróbuj jeszcze raz.**",
        ephemeral: true,
      });
      // remove record so they can request a new puzzle
      pendingVerifications.delete(modalId);
      return;
    }

    // correct answer
    pendingVerifications.delete(modalId);

    let roleId = record.roleId;
    const guild = interaction.guild;

    // if no roleId recorded, try to find dynamically in guild and cache it
    if (!roleId && guild) {
      const normalize = (s = "") =>
        s
          .toString()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9 ]/gi, "")
          .trim()
          .toLowerCase();

      let role =
        guild.roles.cache.find(
          (r) => r.name === DEFAULT_NAMES.verificationRoleName,
        ) ||
        guild.roles.cache.find((r) =>
          normalize(r.name).includes(normalize("klient")),
        );

      if (role) {
        roleId = role.id;
        verificationRoles.set(guild.id, roleId);
        console.log(
          `Dynamicznie ustawiono rolę weryfikacji dla guild ${guild.id}: ${role.name} (${roleId})`,
        );
      } else {
        console.log(
          `Nie znaleziono roli weryfikacji w guild ${guild.id} podczas nadawania roli.`,
        );
      }
    }

    if (!roleId) {
      await interaction.reply({
        content:
          "✅ Poprawnie! Niestety rola weryfikacji nie została znaleziona. Skontaktuj się z administracją.",
        ephemeral: true,
      });
      return;
    }

    try {
      // give role
      const member = await guild.members.fetch(interaction.user.id);
      await member.roles.add(roleId, "Przejście weryfikacji");

      // prepare DM embed (as requested)
      const dmEmbed = new EmbedBuilder()
        .setColor(COLOR_BLUE)
        .setDescription(
          "```\n" +
          "🛒 New Shop × WERYFIKACJA\n" +
          "```\n" +
          "`✨` Gratulacje!\n\n" +
          "`📝` Pomyślnie przeszedłeś weryfikacje na naszym serwerze discord życzymy udanych zakupów!",
        )
        .setTimestamp();

      // send DM to user
      try {
        await interaction.user.send({ embeds: [dmEmbed] });
        // ephemeral confirmation (not public)
        await interaction.reply({
          content: "> \`✅\` **Pomyślnie zweryfikowano**",
          ephemeral: true,
        });
      } catch (dmError) {
        console.error("Nie udało się wysłać DM po weryfikacji:", dmError);
        await interaction.reply({
          content: "> \`✅\` **Pomyślnie zweryfikowano**",
          ephemeral: true,
        });
      }

      console.log(
        `Użytkownik ${interaction.user.username} przeszedł weryfikację na serwerze ${guild.id}`,
      );
    } catch (error) {
      console.error("Błąd przy nadawaniu roli po weryfikacji:", error);
      await interaction.reply({
        content: "> \`❌\` **Wystąpił błąd przy nadawaniu roli.**",
        ephemeral: true,
      });
    }
    return;
  }

  // redeem code modal handling (used in tickets)
  if (interaction.customId.startsWith("modal_redeem_code_")) {
    const enteredCode = interaction.fields
      .getTextInputValue("discount_code")
      .toUpperCase();
    const codeData = activeCodes.get(enteredCode);

    if (!codeData) {
      await interaction.reply({
        content:
          "❌ **Nieprawidłowy kod!**",
        ephemeral: true,
      });
      return;
    }

    // Sprawdź typ kodu
    if (codeData.type === "invite_cash" || codeData.type === "invite_reward") {
      await interaction.reply({
        content:
          "❌ Kod na 50k$ można wpisać jedynie klikając kategorię 'Nagroda za zaproszenia' w TicketPanel i wpisując tam kod!",
        ephemeral: true,
      });
      return;
    }

    if (codeData.used) {
      await interaction.reply({
        content: "❌ **Kod został już wykorzystany!**",
        ephemeral: true,
      });
      return;
    }

    if (Date.now() > codeData.expiresAt) {
      activeCodes.delete(enteredCode);
      await interaction.reply({
        content: "❌ **Kod wygasł!**",
        ephemeral: true,
      });
      return;
    }

    codeData.used = true;
    activeCodes.set(enteredCode, codeData);

    const redeemEmbed = new EmbedBuilder()
      .setColor(0xd4af37)
      .setTitle("\`📉\` WYKORZYSTAŁEŚ KOD RABATOWY")
      .setDescription(
        "```\n" +
        enteredCode +
        "\n```\n" +
        `> \`💸\` × **Otrzymałeś:** \`-${codeData.discount}%\`\n`,
      )
      .setTimestamp();

    await interaction.reply({ embeds: [redeemEmbed] });
    console.log(
      `Użytkownik ${interaction.user.username} odebrał kod rabatowy ${enteredCode} (-${codeData.discount}%)`,
    );
    return;
  }

  // Ticket settings modals: rename/add/remove
  if (interaction.customId.startsWith("modal_rename_")) {
    const chId = interaction.customId.replace("modal_rename_", "");
    const newName = interaction.fields
      .getTextInputValue("new_ticket_name")
      .trim();
    const channel = await interaction.guild.channels
      .fetch(chId)
      .catch(() => null);
    if (!channel) {
      await interaction.reply({
        content: "❌ Błąd z próbą odnalezienia kanału.",
        ephemeral: true,
      });
      return;
    }
    const data = ticketOwners.get(chId) || {
      claimedBy: null,
      ticketMessageId: null,
    };
    const claimer = data.claimedBy;

    if (!isAdminOrSeller(interaction.member)) {
      await interaction.reply({
        content: "❌ Tylko sprzedawca lub admin może to zrobić.",
        ephemeral: true,
      });
      return;
    }
    if (
      claimer &&
      claimer !== interaction.user.id &&
      !isAdminOrSeller(interaction.member)
    ) {
      await interaction.reply({
        content:
          "❌ Tylko osoba która przejęła ticket lub sprzedawca/admin może to zrobić.",
        ephemeral: true,
      });
      return;
    }
    try {
      await channel.setName(newName);

      // prepare DM embed (as requested)
      // send DM to user

      await interaction.reply({
        content: `✅ Zmieniono nazwę ticketu na \`${newName}\`.`,
        ephemeral: true,
      });
    } catch (err) {
      console.error("Błąd zmiany nazwy ticketu:", err);
      await interaction.reply({
        content: "❌ Nie udało się zmienić nazwy ticketu.",
        ephemeral: true,
      });
    }
    return;
  }

  if (interaction.customId.startsWith("modal_add_")) {
    const chId = interaction.customId.replace("modal_add_", "");
    const userInput = interaction.fields
      .getTextInputValue("user_to_add")
      .trim();
    const channel = await interaction.guild.channels
      .fetch(chId)
      .catch(() => null);
    if (!channel) {
      await interaction.reply({
        content: "❌ Kanał nie znaleziony.",
        ephemeral: true,
      });
      return;
    }
    const data = ticketOwners.get(chId) || { claimedBy: null };
    const claimer = data.claimedBy;

    if (!isAdminOrSeller(interaction.member)) {
      await interaction.reply({
        content: "❌ Tylko sprzedawca lub admin może to zrobić.",
        ephemeral: true,
      });
      return;
    }
    if (
      claimer &&
      claimer !== interaction.user.id &&
      !isAdminOrSeller(interaction.member)
    ) {
      await interaction.reply({
        content:
          "❌ Tylko osoba która przejęła ticket lub sprzedawca/admin może to zrobić.",
        ephemeral: true,
      });
      return;
    }

    // parse mention or id
    const match =
      userInput.match(/<@!?(\d+)>/) || userInput.match(/(\d{17,20})/);
    if (!match) {
      await interaction.reply({
        content: "❌ Nieprawidłowy format użytkownika. Podaj @mention lub ID.",
        ephemeral: true,
      });
      return;
    }
    const userIdToAdd = match[1];
    try {
      await channel.permissionOverwrites.edit(userIdToAdd, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
      await interaction.reply({
        content: `✅ Dodano <@${userIdToAdd}> do ticketu.`,
        ephemeral: true,
      });
    } catch (err) {
      console.error("Błąd dodawania użytkownika do ticketu:", err);
      await interaction.reply({
        content: "❌ Nie udało się dodać użytkownika (sprawdź uprawnienia).",
        ephemeral: true,
      });
    }
    return;
  }

  if (interaction.customId.startsWith("modal_remove_")) {
    const chId = interaction.customId.replace("modal_remove_", "");
    const userInput = interaction.fields
      .getTextInputValue("user_to_remove")
      .trim();
    const channel = await interaction.guild.channels
      .fetch(chId)
      .catch(() => null);
    if (!channel) {
      await interaction.reply({
        content: "❌ Kanał nie znaleziony.",
        ephemeral: true,
      });
      return;
    }
    const data = ticketOwners.get(chId) || { claimedBy: null };
    const claimer = data.claimedBy;

    if (!isAdminOrSeller(interaction.member)) {
      await interaction.reply({
        content: "❌ Tylko sprzedawca lub admin może to zrobić.",
        ephemeral: true,
      });
      return;
    }
    if (
      claimer &&
      claimer !== interaction.user.id &&
      !isAdminOrSeller(interaction.member)
    ) {
      await interaction.reply({
        content:
          "❌ Tylko osoba która przejęła ticket lub sprzedawca/admin może to zrobić.",
        ephemeral: true,
      });
      return;
    }

    const match =
      userInput.match(/<@!?(\d+)>/) || userInput.match(/(\d{17,20})/);
    if (!match) {
      await interaction.reply({
        content: "❌ Nieprawidłowy format użytkownika. Podaj @mention lub ID.",
        ephemeral: true,
      });
      return;
    }
    const userIdToRemove = match[1];
    try {
      await channel.permissionOverwrites
        .delete(userIdToRemove)
        .catch(() => null);
      await interaction.reply({
        content: `✅ Usunięto <@${userIdToRemove}> z ticketu.`,
        ephemeral: true,
      });
    } catch (err) {
      console.error("Błąd usuwania użytkownika z ticketu:", err);
      await interaction.reply({
        content: "❌ Nie udało się usunąć użytkownika (sprawdź uprawnienia).",
        ephemeral: true,
      });
    }
    return;
  }

  // Ticket modal flows follow...
  const ticketNumber = getNextTicketNumber(guildId);
  const categories = ticketCategories.get(guildId) || {};
  const user = interaction.user;

  let categoryId;
  let ticketType;
  let ticketTypeLabel;
  let formInfo;
  let ticketTopic;

  switch (interaction.customId) {
    case "modal_zakup": {
      const serwer = interaction.fields.getTextInputValue("serwer");
      const kwotaRaw = interaction.fields.getTextInputValue("kwota");
      const platnosc = interaction.fields.getTextInputValue("platnosc");
      const oczekiwanaWaluta = interaction.fields.getTextInputValue(
        "oczekiwana_waluta",
      );

      // VALIDATION: reject if kwota contains letters (user requested)
      if (/[A-Za-z\u00C0-\u017F]/.test(kwotaRaw)) {
        await interaction.reply({
          content:
            "❌ Proszę podaj kwotę jako samą liczbę (bez liter, np. `40`). Jeśli chciałeś napisać `40zł`, wpisz `40`.",
          ephemeral: true,
        });
        return;
      }

      // extract numeric
      const kwotaNum = parseInt(kwotaRaw.replace(/[^0-9]/g, ""), 10);
      if (Number.isNaN(kwotaNum)) {
        await interaction.reply({
          content: "❌ Nieprawidłowa kwota — wpisz proszę liczbę (np. `40`).",
          ephemeral: true,
        });
        return;
      }

      // if too large (arbitrary safeguard)
      if (kwotaNum > 100000) {
        await interaction.reply({
          content:
            "❌ Podana kwota jest zbyt wysoka. Jeśli to pomyłka, wpisz poprawną kwotę (np. `40`).",
          ephemeral: true,
        });
        return;
      }

      // routing to categories: treat >100 as 100-200+ (user requested)
      if (kwotaNum <= 20) {
        categoryId = categories["zakup-0-20"];
        ticketType = "zakup-0-20";
      } else if (kwotaNum <= 50) {
        categoryId = categories["zakup-20-50"];
        ticketType = "zakup-20-50";
      } else if (kwotaNum <= 100) {
        categoryId = categories["zakup-50-100"];
        ticketType = "zakup-50-100";
      } else {
        // anything above 100 goes to 100-200+ category
        categoryId = categories["zakup-100-200"];
        ticketType = "zakup-100-200";
      }

      ticketTypeLabel = "ZAKUP";
      // Prosty opis bez kalkulacji
      ticketTopic = `Zakup na serwerze: ${serwer}`;
      if (ticketTopic.length > 1024) ticketTopic = ticketTopic.slice(0, 1024);

      formInfo = `> \`➖\` × **Serwer:** \`${serwer}\`\n` +
        `> \`➖\` × **Kwota:** \`${kwotaNum}zł\`\n` +
        `> \`➖\` × **Metoda płatności:** \`${platnosc}\`\n` +
        `> \`➖\` × **Oczekiwana waluta:** \`${oczekiwanaWaluta}\``;
      break;
    }
    case "modal_sprzedaz": {
      const co = interaction.fields.getTextInputValue("co_sprzedac");
      const serwer = interaction.fields.getTextInputValue("serwer");
      const ile = interaction.fields.getTextInputValue("ile");

      categoryId = categories["sprzedaz"];
      ticketType = "sprzedaz";
      ticketTypeLabel = "SPRZEDAŻ";
      formInfo = `> \`➖\` × **Co chce sprzedać:** \`${co}\`\n> \`➖\` × **Serwer:** \`${serwer}\`\n> \`➖\` × **Oczekiwana kwota:** \`${ile}\``;
      break;
    }
    case "modal_odbior": {
      const enteredCodeRaw =
        interaction.fields.getTextInputValue("reward_code") || "";
      const enteredCode = enteredCodeRaw.trim().toUpperCase();

      if (!enteredCode) {
        await interaction.reply({
          content: "❌ Nie podałeś kodu.",
          ephemeral: true,
        });
        return;
      }

      const codeData = activeCodes.get(enteredCode);

      if (!codeData) {
        await interaction.reply({
          content:
            "> \`❌\` **Nieprawidłowy kod!**",
          ephemeral: true,
        });
        return;
      }

      // Sprawdź czy to kod na nagrodę
      if (
        codeData.type !== "invite_cash" &&
        codeData.type !== "invite_reward"
      ) {
        await interaction.reply({
          content:
            "❌ Ten kod nie jest kodem nagrody za zaproszenia. Użyj go w odpowiedniej kategorii.",
          ephemeral: true,
        });
        return;
      }

      if (codeData.used) {
        await interaction.reply({
          content: "❌ Ten kod został już użyty.",
          ephemeral: true,
        });
        return;
      }

      if (Date.now() > (codeData.expiresAt || 0)) {
        activeCodes.delete(enteredCode);
        await interaction.reply({
          content: "❌ Ten kod wygasł.",
          ephemeral: true,
        });
        return;
      }

      // Sprawdź czy kod należy do użytkownika
      if (String(codeData.oderId) !== String(interaction.user.id)) {
        await interaction.reply({
          content:
            "❌ Ten kod nie należy do Ciebie — zrealizować może tylko właściciel kodu (ten, który otrzymał go w DM).",
          ephemeral: true,
        });
        return;
      }

      // Oznacz kod jako użyty
      codeData.used = true;
      activeCodes.set(enteredCode, codeData);

      // Stwórz ticket typu ODBIÓR NAGRODY
      const ticketNumber = getNextTicketNumber(interaction.guildId);
      const categories = ticketCategories.get(interaction.guildId) || {};
      const user = interaction.user;

      const categoryId = REWARDS_CATEGORY_ID;
      const ticketTypeLabel = "NAGRODA ZA ZAPROSZENIA";

      const expiryTs = codeData.expiresAt
        ? Math.floor(codeData.expiresAt / 1000)
        : null;
      const expiryLine = expiryTs
        ? `\n> \`➖\` × **Kod wygasa za:** <t:${expiryTs}:R>`
        : "";

      const formInfo = `> \`➖\` × **Kod:** \`${enteredCode}\`\n> \`➖\` × **Nagroda:** \`${codeData.rewardText || INVITE_REWARD_TEXT || "50k$"}\`${expiryLine}`;

      try {
        let parentToUse = categoryId;
        if (!parentToUse) {
          const foundCat = interaction.guild.channels.cache.find(
            (c) =>
              c.type === ChannelType.GuildCategory &&
              c.name &&
              c.name.toLowerCase().includes("odbior"),
          );
          if (foundCat) parentToUse = foundCat.id;
        }

        const createOptions = {
          name: `ticket-${user.username}`,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            {
              id: interaction.guild.id,
              deny: [PermissionsBitField.Flags.ViewChannel],
            },
            {
              id: user.id,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory,
              ],
            },
          ],
        };
        if (parentToUse) createOptions.parent = parentToUse;

        const channel = await interaction.guild.channels.create(createOptions);

        const embed = new EmbedBuilder()
          .setColor(COLOR_BLUE)
          .setTitle(
            `${client.user?.username || "NEWSHOP"} × ${ticketTypeLabel}`,
          )
          .setDescription(
            `### **ZAKUP ITY × ${ticketTypeLabel}**\n\n` +
            `### ・ \`👤\` × Informacje o kliencie:\n` +
            `> \`➖\` **× Ping:** <@${user.id}>\n` +
            `> \`➖\` × **Nick:** \`${interaction.member?.displayName || user.globalName || user.username}\`\n` +
            `> \`➖\` × **ID:** \`${user.id}\`\n\n` +
            `### ・ \`📋\` × Informacje z formularza:\n` +
            `${formInfo}`,
          )
          .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 128 }))
          .setTimestamp();

        const closeButton = new ButtonBuilder()
          .setCustomId(`ticket_close_${channel.id}`)
          .setLabel("Zamknij")
          .setStyle(ButtonStyle.Secondary);
        const settingsButton = new ButtonBuilder()
          .setCustomId(`ticket_settings_${channel.id}`)
          .setLabel("Ustawienia")
          .setStyle(ButtonStyle.Secondary);
        const claimButton = new ButtonBuilder()
          .setCustomId(`ticket_claim_${channel.id}`)
          .setLabel("Przejmij")
          .setStyle(ButtonStyle.Primary);
        const unclaimButton = new ButtonBuilder()
          .setCustomId(`ticket_unclaim_${channel.id}`)
          .setLabel("Odprzejmij")
          .setStyle(ButtonStyle.Danger)
          .setDisabled(true);

        const buttonRow = new ActionRowBuilder().addComponents(
          closeButton,
          settingsButton,
          claimButton,
          unclaimButton,
        );

        const sentMsg = await channel.send({
          content: `@everyone`,
          embeds: [embed],
          components: [buttonRow],
        });

        ticketOwners.set(channel.id, {
          claimedBy: null,
          userId: user.id,
          ticketMessageId: sentMsg.id,
          locked: false,
        });

        await logTicketCreation(interaction.guild, channel, {
          openerId: user.id,
          ticketTypeLabel,
          formInfo,
          ticketChannelId: channel.id,
          ticketMessageId: sentMsg.id,
        }).catch(() => { });

        await interaction.reply({
          content: `> \`✅\` **Utworzono ticket! Przejdź do:** <#${channel.id}>.`,
          ephemeral: true,
        });
      } catch (err) {
        console.error("Błąd tworzenia ticketu (odbior):", err);
        await interaction.reply({
          content: "❌ Wystąpił błąd podczas tworzenia ticketa.",
          ephemeral: true,
        });
      }
      break;
    }
    case "modal_konkurs_odbior": {
      const info = interaction.fields.getTextInputValue("konkurs_info");

      categoryId = REWARDS_CATEGORY_ID;
      ticketType = "konkurs-nagrody";
      ticketTypeLabel = "NAGRODA ZA KONKURS";
      formInfo = `> \`➖\` × **Informacje:** \`${info}\``;
      break;
    }
    case "modal_inne": {
      const sprawa = interaction.fields.getTextInputValue("sprawa");

      categoryId = categories["inne"];
      ticketType = "inne";
      ticketTypeLabel = "INNE";
      formInfo = `> \`➖\` × **Sprawa:** \`${sprawa}\``;
      break;
    }
    default:
      break;
  }

  // If ticketType not set it was probably a settings modal handled above or unknown
  if (!ticketType) return;

  try {
    // ENFORCE: One ticket per user
    // Search ticketOwners for existing open ticket owned by this user
    for (const [chanId, tData] of ticketOwners.entries()) {
      if (tData && tData.userId === user.id) {
        // ensure channel still exists
        const existingChannel = await interaction.guild.channels
          .fetch(chanId)
          .catch(() => null);
        if (existingChannel) {
          await interaction.reply({
            content: `❌ Masz już otwarty ticket: <#${chanId}> — zamknij go zanim otworzysz nowy.`,
            ephemeral: true,
          });
          return;
        } else {
          // stale entry — remove it
          ticketOwners.delete(chanId);
        }
      }
    }

    // find a fallback category when categoryId undefined — attempt some heuristics
    let parentToUse = null;
    if (categoryId) {
      parentToUse = categoryId;
    } else {
      // heuristics based on ticketType
      const preferNames = {
        "zakup-0-20": "zakup",
        "zakup-20-50": "zakup",
        "zakup-50-100": "zakup",
        "zakup-100-200": "zakup",
        sprzedaz: "sprzedaz",
        "odbior-nagrody": "odbior",
        inne: "inne",
      };
      const prefer = preferNames[ticketType] || ticketType;
      const foundCat = interaction.guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildCategory &&
          c.name &&
          c.name.toLowerCase().includes(prefer),
      );
      if (foundCat) parentToUse = foundCat.id;
      else parentToUse = null;
    }

    // create channel with or without parent
    const createOptions = {
      name: `ticket-${user.username}`,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        {
          id: interaction.guild.id,
          deny: [PermissionsBitField.Flags.ViewChannel], // @everyone nie widzi ticketów
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
      ],
    };

    // Dodaj rangi limitów w zależności od kategorii
    if (parentToUse) {
      const categoryId = parentToUse;
      
      // Zakup 0-20 - wszystkie rangi widzą
      if (categoryId === "1449526840942268526") {
        createOptions.permissionOverwrites.push(
          { id: "1449448705563557918", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 20
          { id: "1449448702925209651", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 50
          { id: "1449448686156255333", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 100
          { id: "1449448860517798061", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }  // limit 200
        );
      }
      // Zakup 20-50 - limit 20 nie widzi
      else if (categoryId === "1449526958508474409") {
        createOptions.permissionOverwrites.push(
          { id: "1449448702925209651", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 50
          { id: "1449448686156255333", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 100
          { id: "1449448860517798061", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }  // limit 200
        );
      }
      // Zakup 50-100 - limit 20 i 50 nie widzą
      else if (categoryId === "1449451716129984595") {
        createOptions.permissionOverwrites.push(
          { id: "1449448686156255333", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 100
          { id: "1449448860517798061", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }  // limit 200
        );
      }
      // Zakup 100-200 - tylko limit 200 widzi
      else if (categoryId === "1449452354201190485") {
        createOptions.permissionOverwrites.push(
          { id: "1449448860517798061", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }  // limit 200
        );
      }
      // Sprzedaż - wszystkie rangi widzą
      else if (categoryId === "1449455848043708426") {
        createOptions.permissionOverwrites.push(
          { id: "1449448705563557918", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 20
          { id: "1449448702925209651", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 50
          { id: "1449448686156255333", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 100
          { id: "1449448860517798061", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }  // limit 200
        );
      }
      // Inne - wszystkie rangi widzą
      else if (categoryId === "1449527585271976131") {
        createOptions.permissionOverwrites.push(
          { id: "1449448705563557918", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 20
          { id: "1449448702925209651", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 50
          { id: "1449448686156255333", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }, // limit 100
          { id: "1449448860517798061", allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }  // limit 200
        );
      }
    }
    if (ticketTopic) createOptions.topic = ticketTopic;
    if (parentToUse) createOptions.parent = parentToUse;

    const channel = await interaction.guild.channels.create(createOptions);

    const embed = new EmbedBuilder()
      .setColor(COLOR_BLUE) // Discord blurple (#5865F2)
      .setDescription(
        `## \`🛒 NEW SHOP × ${ticketTypeLabel}\`\n\n` +
        `### ・ \`👤\` × Informacje o kliencie:\n` +
        `> \`➖\` **× Ping:** <@${user.id}>\n` +
        `> \`➖\` × **Nick:** \`${interaction.member?.displayName || user.globalName || user.username}\`\n` +
        `> \`➖\` × **ID:** \`${user.id}\`\n` +
        `### ・ \`📋\` × Informacje z formularza:\n` +
        `${formInfo}`,
      )
      .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 128 })) // avatar user po prawej
      .setTimestamp();

    // Build buttons: Close (disabled for non-admin in interaction), Settings, Code (if zakup), Claim + Unclaim (disabled)
    const closeButton = new ButtonBuilder()
      .setCustomId(`ticket_close_${channel.id}`)
      .setLabel("Zamknij")
      .setStyle(ButtonStyle.Secondary);

    const settingsButton = new ButtonBuilder()
      .setCustomId(`ticket_settings_${channel.id}`)
      .setLabel("Ustawienia")
      .setStyle(ButtonStyle.Secondary);

    const buttons = [closeButton, settingsButton];

    if (ticketTypeLabel === "ZAKUP") {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`ticket_code_${channel.id}_${user.id}`)
          .setLabel("Kod rabatowy")
          .setStyle(ButtonStyle.Secondary),
      );
    }

    const claimButton = new ButtonBuilder()
      .setCustomId(`ticket_claim_${channel.id}`)
      .setLabel("Przejmij")
      .setStyle(ButtonStyle.Secondary);

    const unclaimButton = new ButtonBuilder()
      .setCustomId(`ticket_unclaim_${channel.id}`)
      .setLabel("Odprzejmij")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);

    buttons.push(claimButton, unclaimButton);

    const buttonRow = new ActionRowBuilder().addComponents(...buttons);

    // send message and capture it (so we can edit buttons later)
    const sentMsg = await channel.send({
      content: `@everyone`,
      embeds: [embed],
      components: [buttonRow],
    });

    ticketOwners.set(channel.id, {
      claimedBy: null,
      userId: user.id,
      ticketMessageId: sentMsg.id,
      locked: false,
    });

    // LOG: ticket creation in logi-ticket channel (if exists)
    try {
      await logTicketCreation(interaction.guild, channel, {
        openerId: user.id,
        ticketTypeLabel,
        formInfo,
        ticketChannelId: channel.id,
        ticketMessageId: sentMsg.id,
      }).catch((e) => console.error("logTicketCreation error:", e));
    } catch (e) {
      console.error("Błąd logowania utworzenia ticketu:", e);
    }

    await interaction.reply({
      content: `> \`✅\` **Utworzono ticket! Przejdź do:** <#${channel.id}>`,
      ephemeral: true,
    });
  } catch (error) {
    console.error("Błąd tworzenia ticketu:", error);
    await interaction.reply({
      content: "❌ Wystąpił błąd podczas tworzenia ticketu.",
      ephemeral: true,
    });
  }
}

// message create handler: enforce channel restrictions and keep existing legitcheck behavior
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // ANTI-DISCORD-INVITE: delete invite links and timeout user for 30 minutes
  try {
    const content = message.content || "";
    const inviteRegex =
      /(https?:\/\/)?(www\.)?(discord\.gg|discord(?:app)?\.com\/invite)\/[^\s/]+/i;
    if (inviteRegex.test(content)) {
      // delete message first
      try {
        await message.delete().catch(() => null);
      } catch (e) {
        // ignore
      }
      // attempt to timeout the member for 30 minutes (1800 seconds = 30 minutes)
      try {
        const member = message.member;
        if (member && typeof member.timeout === "function") {
          const ms = 30 * 60 * 1000;
          await member
            .timeout(ms, "Wysłanie linku Discord invite/discord.gg")
            .catch(() => null);
        } else if (member && member.manageable) {
          // fallback: try to add a muted role named 'Muted' (best-effort)
          const guild = message.guild;
          let mutedRole = guild.roles.cache.find(
            (r) => r.name.toLowerCase() === "muted",
          );
          if (!mutedRole) {
            try {
              mutedRole = await guild.roles
                .create({ name: "Muted", permissions: [] })
                .catch(() => null);
            } catch (e) {
              mutedRole = null;
            }
          }
          if (mutedRole) {
            await member.roles.add(mutedRole).catch(() => null);
            // schedule removal in 30 minutes
            setTimeout(
              () => {
                guild.members
                  .fetch(member.id)
                  .then((m) => {
                    m.roles.remove(mutedRole).catch(() => null);
                  })
                  .catch(() => null);
              },
              30 * 60 * 1000,
            );
          }
        }
      } catch (err) {
        console.error("Nie udało się dać muta/timeout po wysłaniu linka:", err);
      }

      // notify channel briefly
      try {
        const warn = await message.channel.send({
          content: `<@${message.author.id}>`,
          embeds: [
            new EmbedBuilder()
              .setColor(COLOR_RED)
              .setDescription(
                "• `❗` __**Wysyłanie linków Discord jest zabronione otrzymujesz mute na 30 minut**__",
              ),
          ],
        });
        setTimeout(() => warn.delete().catch(() => null), 6_000);
      } catch (e) {
        // ignore
      }
      return;
    }
  } catch (e) {
    console.error("Błąd podczas sprawdzania linków zaproszeń:", e);
  }

  // Invalid-channel embeds (customized)
  const opinInvalidEmbed = new EmbedBuilder()
    .setColor(COLOR_RED)
    .setDescription(
      `• \`❗\` __**Na tym kanale można wystawiać tylko opinie!**__`,
    );

  const dropInvalidEmbed = new EmbedBuilder()
    .setColor(COLOR_RED)
    .setDescription(
      `• \`❗\` __**Na tym kanale można losować tylko zniżki!**__`,
    );

  // Enforce drop-channel-only rule (only allow messages starting with "/drop")
  try {
    const guildId = message.guildId;
    if (guildId) {
      const dropChannelId = dropChannels.get(guildId);
      if (dropChannelId && message.channel.id === dropChannelId) {
        const content = (message.content || "").trim();
        // allow if message begins with "/drop" (user typed it)
        if (!content.toLowerCase().startsWith("/drop")) {
          // delete and warn
          try {
            await message.delete().catch(() => null);
          } catch (e) {
            // ignore
          }
          try {
            const warnMsg = await message.channel.send({
              content: `<@${message.author.id}>`,
              embeds: [dropInvalidEmbed],
            });
            setTimeout(() => warnMsg.delete().catch(() => { }), 3000);
          } catch (e) {
            // ignore
          }
          return;
        }
      }
    }
  } catch (e) {
    console.error("Błąd przy egzekwowaniu reguły kanału drop:", e);
  }

  // Enforce opinie-channel-only rule (only allow messages starting with "/opinia")
  try {
    const guildId = message.guildId;
    if (guildId) {
      const opinieChannelId = opinieChannels.get(guildId);
      if (opinieChannelId && message.channel.id === opinieChannelId) {
        const content = (message.content || "").trim();
        if (!content.toLowerCase().startsWith("/opinia")) {
          // delete and warn
          try {
            await message.delete().catch(() => null);
          } catch (e) {
            // ignore
          }
          try {
            const warnMsg = await message.channel.send({
              content: `<@${message.author.id}>`,
              embeds: [opinInvalidEmbed],
            });
            setTimeout(() => warnMsg.delete().catch(() => { }), 3000);
          } catch (e) {
            // ignore
          }
          return;
        } else {
          // If user typed plain "/opinia" (not using slash command) we should also enforce per-user cooldown here.
          const last = opinionCooldowns.get(message.author.id) || 0;
          if (Date.now() - last < OPINION_COOLDOWN_MS) {
            const remaining = OPINION_COOLDOWN_MS - (Date.now() - last);
            try {
              await message.delete().catch(() => null);
            } catch (e) { }
            try {
              const warnMsg = await message.channel.send({
                content: `<@${message.author.id}>`,
                embeds: [
                  new EmbedBuilder()
                    .setColor(COLOR_BLUE)
                    .setDescription(
                      `• \`❗\` Musisz poczekać ${humanizeMs(remaining)}, zanim użyjesz /opinia ponownie.`,
                    ),
                ],
              });
              setTimeout(() => warnMsg.delete().catch(() => { }), 4000);
            } catch (e) { }
            return;
          } else {
            // allow typed /opinia but start cooldown
            opinionCooldowns.set(message.author.id, Date.now());
            // delete typed /opinia to reduce clutter:
            try {
              await message.delete().catch(() => null);
            } catch (e) { }
            // Inform user to use slash command properly (instruction should be yellow and mention command id)
            try {
              const info = await message.channel.send({
                content: `<@${message.author.id}>`,
                embeds: [
                  new EmbedBuilder()
                    .setColor(COLOR_YELLOW)
                    .setDescription(
                      `Użyj komendy </opinia:1454974442873553113> aby wystawić opinię — post został przyjęty.`,
                    ),
                ],
              });
              setTimeout(() => info.delete().catch(() => { }), 3000);
            } catch (e) { }
            return;
          }
        }
      }
    }
  } catch (e) {
    console.error("Błąd przy egzekwowaniu reguły kanału opinii:", e);
  }

  // Enforce zaproszenia-check-only channel rule:
  try {
    const content = (message.content || "").trim();
    const zapCh = message.guild
      ? message.guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildText &&
          (c.name === "❓-×┃sprawdz-zapro" ||
            c.name.includes("sprawdz-zapro") ||
            c.name.includes("sprawdz-zaproszenia")),
      )
      : null;

    if (zapCh && message.channel.id === zapCh.id) {
      // allow only if typed command starts with /sprawdz-zaproszenia
      if (!content.toLowerCase().startsWith("/sprawdz-zaproszenia")) {
        try {
          await message.delete().catch(() => null);
        } catch (e) { }
        try {
          const warnEmbed = new EmbedBuilder()
            .setColor(COLOR_RED)
            .setDescription(
              `• \`❗\` __**Na tym kanale można sprawdzać tylko swoje zaproszenia!**__`,
            );
          const warn = await message.channel.send({
            content: `<@${message.author.id}>`,
            embeds: [warnEmbed],
          });
          setTimeout(() => warn.delete().catch(() => { }), 4000);
        } catch (e) { }
        return;
      } else {
        // typed the command - allow (but delete to reduce clutter)
        try {
          await message.delete().catch(() => null);
        } catch (e) { }
        return;
      }
    }
  } catch (e) {
    console.error("Błąd przy egzekwowaniu reguły kanału zaproszenia:", e);
  }

  // If any message is sent in the specific legitcheck-rep channel
  if (
    message.channel &&
    message.channel.id === REP_CHANNEL_ID &&
    !message.author.bot
  ) {
    try {
      // ignore empty messages or slash-like content
      if (!message.content || message.content.trim().length === 0) return;
      if (message.content.trim().startsWith("/")) return;

      const channel = message.channel;

      // Pattern: +rep @user [action] [amount] [server]
      const repPattern = /^\+rep\s+<@!?(\d+)>\s+\S+\s+\S+\s+.+$/i;
      const isValidRep = repPattern.test(message.content.trim());

      if (!isValidRep) {
        // Delete invalid message and send warning
        try {
          await message.delete();
          const warningEmbed = new EmbedBuilder()
            .setColor(COLOR_RED)
            .setDescription(
              `• \`❗\` __**Stosuj się do wzoru legit checka!**__`,
            );
          const warningMsg = await channel.send({
            content: `<@${message.author.id}>`,
            embeds: [warningEmbed],
          });
          setTimeout(() => warningMsg.delete().catch(() => { }), 2000);
        } catch (delErr) {
          console.error("Błąd usuwania nieprawidłowej wiadomości:", delErr);
        }
        return;
      }

      // Valid +rep message - increment counter
      legitRepCount++;
      console.log(`+rep otrzymany! Licznik: ${legitRepCount}`);

      // Use scheduled rename (respect cooldown)
      scheduleRepChannelRename(channel, legitRepCount).catch(() => null);
      scheduleSavePersistentState();

      // cooldown per user for info embed
      const last = infoCooldowns.get(message.author.id) || 0;
      if (Date.now() - last < INFO_EMBED_COOLDOWN_MS) {
        console.log(`Cooldown dla ${message.author.username}, pomijam embed`);
        return;
      }
      infoCooldowns.set(message.author.id, Date.now());
      console.log(`Wysyłam embed dla ${message.author.username}`);

      // delete previous info message (if we posted one earlier in this channel) to move new one to bottom
      const prevId = repLastInfoMessage.get(channel.id);
      if (prevId) {
        try {
          const prevMsg = await channel.messages
            .fetch(prevId)
            .catch(() => null);
          if (prevMsg && prevMsg.deletable) {
            await prevMsg.delete().catch(() => null);
          }
        } catch (delErr) {
          console.warn(
            "Nie udało się usunąć poprzedniej wiadomości info:",
            delErr,
          );
        }
      }

      // ID użytkownika
      const userID = "1305200545979437129";

      let attachment = null;
      let imageUrl = "https://share.creavite.co/693f180207e523c90b19fbf9.gif"; // fallback URL

      try {
        const gifPath = path.join(
          __dirname,
          "attached_assets",
          "standard_1765794552774_1766946611654.gif",
        );
        attachment = new AttachmentBuilder(gifPath, { name: "legit.gif" });
        imageUrl = "attachment://legit.gif";
      } catch (err) {
        console.warn(
          "Nie udało się załadować lokalnego GIFa do legit embed:",
          err,
        );
        attachment = null;
      }

      const infoEmbed = new EmbedBuilder()
        .setColor(COLOR_BLUE) // informational embed left color -> blue (rest is blue)
        .setDescription(
          "```\n" +
          "✅ New Shop × LEGIT CHECK\n" +
          "```\n" +
          "- `📝` **× Wzór:**\n" +
          `> \`+rep @sprzedawca [sprzedał/kupił/wręczył nagrode] [ile] [serwer]\`\n\n` +
          "- `📋` **× Przykład**\n" +
          `> **+rep <@1305200545979437129> sprzedał 400k anarchia lf**\n\n` +
          `*Aktualna liczba legitcheck: **${legitRepCount}***`,
        )
        .setImage(imageUrl)
        .setTimestamp();

      // Always send a new info message (after deleting the previous one) so it appears below the new +rep
      try {
        const sendOptions = {
          embeds: [infoEmbed],
          allowedMentions: { users: [userID] },
        };
        if (attachment) sendOptions.files = [attachment];

        const sent = await channel.send(sendOptions);
        repLastInfoMessage.set(channel.id, sent.id);
      } catch (err) {
        console.error("Błąd wysyłania info embed (nowy):", err);
      }
    } catch (err) {
      console.error("Błąd wysyłania info embed na legitcheck-rep:", err);
    }
  }

  if (message.content.toLowerCase().trim() === "legit") {
    // legacy: no legit flows for now
    return;
  }

  if (message.content === "!ping") {
    message.reply("Pong!");
  }
});

// ----------------- OPINIA handler (updated to match provided layout + delete & re-send instruction so it moves to bottom) -----------------

async function handleOpinionCommand(interaction) {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await interaction.reply({
      content: "❌ Ta komenda działa tylko na serwerze!",
      ephemeral: true,
    });
    return;
  }

  // Enforce per-user cooldown for /opinia (30 minutes)
  const lastUsed = opinionCooldowns.get(interaction.user.id) || 0;
  if (Date.now() - lastUsed < OPINION_COOLDOWN_MS) {
    const remaining = OPINION_COOLDOWN_MS - (Date.now() - lastUsed);
    await interaction.reply({
      content: `❌ Możesz użyć /opinia ponownie za ${humanizeMs(remaining)}.`,
      ephemeral: true,
    });
    return;
  }

  const normalize = (s = "") =>
    s
      .toString()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 _-]/gi, "")
      .trim()
      .toLowerCase();

  let allowedChannelId = opinieChannels.get(guildId);
  if (!allowedChannelId) {
    const found = interaction.guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        (c.name === "⭐-×┃opinie-klientow" ||
          normalize(c.name).includes("opinie") ||
          normalize(c.name).includes("opinie-klientow")),
    );
    if (found) {
      allowedChannelId = found.id;
      opinieChannels.set(guildId, found.id);
    }
  }

  if (!allowedChannelId || interaction.channelId !== allowedChannelId) {
    await interaction.reply({
      content: `❌ Komendę </opinia:1454974442873553113> można użyć tylko na kanale <#${allowedChannelId || "⭐-×┃opinie-klientow"}>.`,
      ephemeral: true,
    });
    return;
  }

  // mark cooldown (successful invocation)
  opinionCooldowns.set(interaction.user.id, Date.now());

  // Pobranie opcji
  const czas = interaction.options.getInteger("czas_oczekiwania");
  const jakosc = interaction.options.getInteger("jakosc_produktu");
  const cena = interaction.options.getInteger("cena_produktu");
  const tresc = interaction.options.getString("tresc_opinii");

  // helper na gwiazdki
  const stars = (n) => {
    const count = Math.max(0, Math.min(5, n || 0));
    if (count === 0) return null;
    return "⭐".repeat(count);
  };
  const starsInline = (n) => {
    const s = stars(n);
    return s ? `\`${s}\`` : "Brak ocena";
  };

  // wrap tresc in inline code backticks so it appears with dark bg in embed
  const safeTresc = tresc ? `\`${tresc}\`` : "`-`";

  // Budujemy opis jako pojedynczy string — używamy tablicy i join(\n) żeby zachować czytelność
  const description = [
    "```",
    "✅ New Shop × OPINIA",
    "```",
    `> \`👤\` **× Twórca opinii:** <@${interaction.user.id}>`,
    `> \`📝\` **× Treść:** ${safeTresc}`,
    "",
    `> \`⌛\` **× Czas oczekiwania:** ${starsInline(czas)}`,
    `> \`📋\` **× Jakość produktu:** ${starsInline(jakosc)}`,
    `> \`💸\` **× Cena produktu:** ${starsInline(cena)}`,
  ].join("\n");

  // Tworzymy embed z poprawnym description
  const opinionEmbed = new EmbedBuilder()
    .setColor(COLOR_BLUE)
    .setDescription(description)
    .setThumbnail(
      interaction.user.displayAvatarURL({ dynamic: true, size: 128 }),
    )
    .setTimestamp();

  // instrukcja — będzie na żółto i użyje mention dla komendy /opinia
  const instructionEmbed = new EmbedBuilder()
    .setColor(0xffd700)
    .setDescription(
      "`📊` Użyj komendy </opinia:1454974442873553113>, aby podzielić się opinią o naszym serwerze!",
    );
  try {
    const channel = interaction.channel;

    // Spróbuj użyć webhooka do wysłania opinii z nazwą równą displayName użytkownika
    // (wygląda jakby wysłał użytkownik — ale to nadal webhook)
    let botWebhook = null;
    try {
      const webhooks = await channel.fetchWebhooks();
      botWebhook = webhooks.find(
        (w) => w.owner?.id === client.user.id && w.name === "ZAKUP_ITy_OPINIE",
      );
    } catch (e) {
      botWebhook = null;
    }

    if (!botWebhook) {
      try {
        botWebhook = await channel.createWebhook({
          name: "ZAKUP_ITy_OPINIE",
          avatar: client.user.displayAvatarURL({ dynamic: true }),
          reason: "Webhook do publikowania opinii",
        });
      } catch (createErr) {
        botWebhook = null;
      }
    }

    if (botWebhook) {
      const displayName =
        interaction.member?.displayName || interaction.user.username;
      await botWebhook.send({
        username: displayName,
        avatarURL: interaction.user.displayAvatarURL({ dynamic: true }),
        embeds: [opinionEmbed],
        wait: true,
      });
    } else {
      await channel.send({ embeds: [opinionEmbed] });
    }

    // Delete previous instruction message (if exists) so the new one will be posted BELOW the just-sent opinion
    const channelId = channel.id;
    let instrMsg = null;

    if (lastOpinionInstruction.has(channelId)) {
      instrMsg = await channel.messages
        .fetch(lastOpinionInstruction.get(channelId))
        .catch(() => null);
      if (!instrMsg) lastOpinionInstruction.delete(channelId);
    }

    if (!instrMsg) {
      // try to find in recent messages one with the same description (old instruction leftover)
      const found = await findBotMessageWithEmbed(
        channel,
        (emb) =>
          typeof emb.description === "string" &&
          (emb.description.includes(
            "Użyj komendy </opinia:1454974442873553113>",
          ) ||
            emb.description.includes("Użyj komendy `/opinia`")),
      );
      if (found) instrMsg = found;
    }

    if (instrMsg) {
      try {
        if (instrMsg.deletable) {
          await instrMsg.delete().catch(() => null);
        }
      } catch (e) {
        // ignore
      }
      lastOpinionInstruction.delete(channelId);
    }

    // Send a fresh instruction message (so it will be at the bottom)
    try {
      const sent = await channel.send({ embeds: [instructionEmbed] });
      lastOpinionInstruction.set(channelId, sent.id);
    } catch (e) {
      // ignore (maybe no perms)
    }

    await interaction.reply({
      content: "✅ Twoja opinia została opublikowana.",
      ephemeral: true,
    });
  } catch (err) {
    console.error("Błąd publikacji opinii:", err);
    try {
      await interaction.reply({
        content: "❌ Wystąpił błąd podczas publikacji opinii.",
        ephemeral: true,
      });
    } catch (e) {
      // ignore
    }
  }
}
// ---------------------------------------------------

// Helper sleep
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
  NEW: /wyczysckanal handler
  - tryb: "wszystko" -> usuwa jak najwięcej wiadomości (pomija pinned)
  - tryb: "ilosc" -> usuwa określoną ilość (1-100)
  Notes:
  - Bulk delete nie usuwa wiadomości starszych niż 14 dni; w tym przypadku pojedyncze usuwanie jest używane jako fallback (może być wolne).
  - Command requires ManageMessages permission by default (set in command registration) but we double-check at runtime.
*/
async function handleWyczyscKanalCommand(interaction) {
  const guildId = interaction.guildId;
  const channel = interaction.channel;

  if (!guildId || !interaction.guild) {
    await interaction.reply({
      content: "❌ Ta komenda działa tylko na serwerze!",
      ephemeral: true,
    });
    return;
  }

  // Defer to avoid timeout and allow multiple replies
  await interaction.deferReply({ ephemeral: true }).catch(() => null);

  // permissions check (member)
  const member = interaction.member;
  const hasManage =
    (member &&
      member.permissions &&
      member.permissions.has(PermissionFlagsBits.ManageMessages)) ||
    (member &&
      member.permissions &&
      member.permissions.has(PermissionFlagsBits.Administrator));

  if (!hasManage) {
    try {
      await interaction.editReply({
        content:
          "❌ Nie masz uprawnień do zarządzania wiadomościami (MANAGE_MESSAGES).",
      });
    } catch (e) {
      // ignore
    }
    return;
  }

  // only text channels
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildVoice &&
      channel.type !== ChannelType.GuildAnnouncement &&
      channel.type !== ChannelType.GuildForum &&
      channel.type !== ChannelType.GuildStageVoice &&
      channel.type !== ChannelType.GuildCategory)
  ) {
    // simpler: require GuildText
    if (channel.type !== ChannelType.GuildText) {
      try {
        await interaction.editReply({
          content:
            "❌ Ta komenda działa tylko na zwykłych kanałach tekstowych (nie w prywatnych wiadomościach).",
        });
      } catch (e) {
        // ignore
      }
      return;
    }
  }

  const mode = interaction.options.getString("tryb");
  const amount = interaction.options.getInteger("ilosc") || 0;

  try {
    if (mode === "ilosc") {
      // validate amount
      if (amount <= 0 || amount > 100) {
        try {
          await interaction.editReply({
            content: "❌ Podaj poprawną ilość wiadomości do usunięcia (1-100).",
          });
        } catch (e) {
          // ignore
        }
        return;
      }

      // Use bulkDelete with filterOld = true to avoid error on >14days messages
      const deleted = await channel.bulkDelete(amount, true);
      const deletedCount = deleted.size || 0;

      try {
        await interaction.editReply({
          content: `✅ Usunięto ${deletedCount} wiadomości z tego kanału.`,
        });
      } catch (e) {
        // ignore
      }
      return;
    }

    if (mode === "wszystko") {
      try {
        await interaction.editReply({
          content:
            "🧹 Rozpoczynam czyszczenie kanału. To może potrwać (usuwam wszystkie nie-przypięte wiadomości)...",
        });
      } catch (e) {
        // ignore
      }

      let totalDeleted = 0;
      // loop fetching up to 100 messages and deleting them until none left (or stuck)
      while (true) {
        // fetch up to 100 messages
        const fetched = await channel.messages.fetch({ limit: 100 });
        if (!fetched || fetched.size === 0) break;

        // filter out pinned messages
        const toDelete = fetched.filter((m) => !m.pinned);

        if (toDelete.size === 0) {
          // nothing to delete in this batch (all pinned) -> stop
          break;
        }

        try {
          // bulkDelete with filterOld true to avoid errors on >14d
          const deleted = await channel.bulkDelete(toDelete, true);
          const count = deleted.size || 0;
          totalDeleted += count;

          // If some messages couldn't be bulk-deleted because older than 14 days,
          // bulkDelete will just skip them when filterOld = true, so handle leftovers manually.
          // Collect leftovers (those not deleted and not pinned) and delete individually.
          const remaining = toDelete.filter((m) => !deleted.has(m.id));
          if (remaining.size > 0) {
            for (const m of remaining.values()) {
              try {
                await m.delete().catch(() => null);
                totalDeleted++;
                // small delay to avoid rate limits
                await sleep(200);
              } catch (err) {
                // ignore single deletion errors
              }
            }
          }
        } catch (err) {
          // fallback: if bulkDelete fails for any reason, delete individually
          console.warn(
            "bulkDelete nie powiodło się, przechodzę do indywidualnego usuwania:",
            err,
          );
          for (const m of toDelete.values()) {
            try {
              await m.delete().catch(() => null);
              totalDeleted++;
              await sleep(200);
            } catch (e) {
              // ignore
            }
          }
        }

        // small pause to be polite with rate limits
        await sleep(500);

        // try next batch
      }

      await interaction.editReply({
        content: `✅ Czyszczenie zakończone. Usunięto około ${totalDeleted} wiadomości. (Pamiętaj: wiadomości przypięte zostały zachowane, a wiadomości starsze niż 14 dni mogły być usunięte indywidualnie lub pominięte).`,
      });
      return;
    }

    try {
      await interaction.editReply({
        content: "❌ Nieznany tryb. Wybierz 'wszystko' lub 'ilosc'.",
      });
    } catch (e) {
      // ignore
    }
  } catch (error) {
    console.error("Błąd wyczyszczenia kanału:", error);
    try {
      await interaction.editReply({
        content: "❌ Wystąpił błąd podczas czyszczenia kanału.",
      });
    } catch (e) {
      // ignore
    }
  }
}

/*
  NEW: schedule and perform rep channel rename while respecting cooldown
  - If immediate rename allowed (cooldown passed), perform now.
  - Otherwise schedule a single delayed rename to occur when cooldown ends.
  - pendingRename prevents multiple overlapping scheduled renames.
*/
async function scheduleRepChannelRename(channel, count) {
  if (!channel || typeof channel.setName !== "function") return;

  const newName = `✅-×┃legit-rep➔${count}`;
  const now = Date.now();
  const since = now - lastChannelRename;
  const remaining = Math.max(0, CHANNEL_RENAME_COOLDOWN - since);

  if (remaining === 0 && !pendingRename) {
    // do it now
    pendingRename = true;
    try {
      await channel.setName(newName);
      lastChannelRename = Date.now();
      console.log(`Zmieniono nazwę kanału na: ${newName}`);
    } catch (err) {
      console.error("Błąd zmiany nazwy kanału (natychmiastowa próba):", err);
    } finally {
      pendingRename = false;
    }
  } else {
    // schedule once (if not already scheduled)
    if (pendingRename) {
      // already scheduled — we won't schedule another to avoid piling many timeouts.
      console.log(
        `Zmiana nazwy kanału już zaplanowana. Nowa nazwa zostanie ustawiona przy najbliższej okazji: ${newName}`,
      );
      return;
    }

    pendingRename = true;
    const when = lastChannelRename + CHANNEL_RENAME_COOLDOWN;
    const delay = Math.max(0, when - now) + 1000; // add small safety buffer
    console.log(`Planuję zmianę nazwy kanału na ${newName} za ${delay} ms`);

    setTimeout(async () => {
      try {
        await channel.setName(newName);
        lastChannelRename = Date.now();
        console.log(`Zaplanowana zmiana nazwy wykonana: ${newName}`);
      } catch (err) {
        console.error("Błąd zmiany nazwy kanału (zaplanowana próba):", err);
      } finally {
        pendingRename = false;
      }
    }, delay);
  }
}

/*
  NEW: /resetlc handler
  - Admin-only command (default member permission set)
  - Resets legitRepCount to 0 and attempts to rename the counter channel.
  - If rename cannot be performed immediately due to cooldown, it will be scheduled.
*/
async function handleResetLCCommand(interaction) {
  // ensure command used in guild
  if (!interaction.guild) {
    try {
      await interaction.reply({
        content: "❌ Ta komenda działa tylko na serwerze!",
        ephemeral: true,
      });
    } catch (e) {
      console.error("Nie udało się odpowiedzieć (brak guild):", e);
    }
    return;
  }

  // permission check BEFORE deferring (fast)
  const member = interaction.member;
  const isAdmin =
    member &&
    member.permissions &&
    (member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild));
  if (!isAdmin) {
    try {
      await interaction.reply({
        content:
          "❌ Nie masz uprawnień administracyjnych, aby zresetować licznik.",
        ephemeral: true,
      });
    } catch (e) {
      console.error("Nie udało się odpowiedzieć o braku uprawnień:", e);
    }
    return;
  }

  // Defer reply to avoid "App is not responding" while we perform work
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (e) {
    console.warn("Nie udało się deferReply (może już odpowiedziano):", e);
  }

  console.log(
    `[resetlc] Użytkownik ${interaction.user.tag} (${interaction.user.id}) żąda resetu licznika.`,
  );

  // reset counter
  legitRepCount = 0;
  scheduleSavePersistentState();

  try {
    const channel = await client.channels
      .fetch(REP_CHANNEL_ID)
      .catch(() => null);
    if (!channel) {
      console.warn(
        `[resetlc] Nie znaleziono kanału o ID ${REP_CHANNEL_ID} lub bot nie ma do niego dostępu.`,
      );
      await interaction.editReply({
        content:
          "✅ Licznik został zresetowany lokalnie, ale nie udało się znaleźć kanału z licznikiem (sprawdź REP_CHANNEL_ID i uprawnienia bota).",
      });
      return;
    }

    // Try immediate rename if cooldown allows, otherwise schedule
    const now = Date.now();
    const since = now - lastChannelRename;
    const remaining = Math.max(0, CHANNEL_RENAME_COOLDOWN - since);

    if (remaining === 0 && !pendingRename) {
      try {
        // attempt immediate rename (may fail if missing ManageChannels)
        await channel.setName(`✅-×┃legit-rep➔${legitRepCount}`);
        lastChannelRename = Date.now();
        pendingRename = false;
        console.log(`[resetlc] Kanał ${channel.id} zaktualizowany do 0.`);
        await interaction.editReply({
          content:
            "✅ Licznik legitchecków został zresetowany do 0, nazwa kanału została zaktualizowana.",
        });
        return;
      } catch (err) {
        console.error(
          "[resetlc] Błąd przy natychmiastowej zmianie nazwy kanału:",
          err,
        );
        // fallback to scheduling
        await scheduleRepChannelRename(channel, legitRepCount);
        await interaction.editReply({
          content:
            "✅ Licznik został zresetowany do 0. Nie udało się natychmiast zaktualizować nazwy kanału — zmiana została zaplanowana.",
        });
        return;
      }
    } else {
      // schedule rename respecting cooldown
      await scheduleRepChannelRename(channel, legitRepCount);
      await interaction.editReply({
        content:
          "✅ Licznik został zresetowany do 0. Nazwa kanału zostanie zaktualizowana za kilka minut (szanujemy cooldown Discorda).",
      });
      return;
    }
  } catch (err) {
    console.error("[resetlc] Błąd podczas resetowania licznika:", err);
    try {
      await interaction.editReply({
        content: "❌ Wystąpił błąd podczas resetowania licznika.",
      });
    } catch (e) {
      console.error("Nie udało się wysłać editReply po błędzie:", e);
    }
  }
}

/*
  NEW: /zresetujczasoczekiwania handler
  - Admin-only command that clears cooldowns for /drop and /opinia (and internal info).
*/
async function handleZresetujCzasCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "❌ Ta komenda działa tylko na serwerze!",
      ephemeral: true,
    });
    return;
  }

  // permission check
  const member = interaction.member;
  const isAdmin =
    member &&
    member.permissions &&
    (member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild));
  if (!isAdmin) {
    await interaction.reply({
      content: "❌ Nie masz uprawnień administracyjnych.",
      ephemeral: true,
    });
    return;
  }

  try {
    // clear cooldown maps
    dropCooldowns.clear();
    opinionCooldowns.clear();
    infoCooldowns.clear();

    await interaction.reply({
      content:
        "✅ Czasy oczekiwania dla /drop, /opinia oraz wewnętrznych info zostały zresetowane.",
      ephemeral: true,
    });
    console.log(
      `[zresetujczasoczekiwania] Użytkownik ${interaction.user.tag} zresetował cooldowny.`,
    );
  } catch (err) {
    console.error("[zresetujczasoczekiwania] Błąd:", err);
    await interaction.reply({
      content: "❌ Wystąpił błąd podczas resetowania czasów oczekiwania.",
      ephemeral: true,
    });
  }
}

// ----------------- Welcome message system + Invite tracking & protections -----------------
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    // find channel by exact name or containing 'lobby'
    const ch =
      member.guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildText &&
          (c.name === "👋-×┃lobby" || c.name.toLowerCase().includes("lobby")),
      ) || null;

    // --- Robust invite detection ---
    let inviterId = null;
    let countThisInvite = false;
    let isFakeAccount = false;

    try {
      // jeśli ten użytkownik wcześniej opuścił i mieliśmy to zapisane -> usuń "leave" (kompensacja)
      const memberKey = `${member.guild.id}:${member.id}`;
      if (leaveRecords.has(memberKey)) {
        try {
          const prevInviter = leaveRecords.get(memberKey);
          if (prevInviter) {
            if (!inviteLeaves.has(member.guild.id))
              inviteLeaves.set(member.guild.id, new Map());
            const lMap = inviteLeaves.get(member.guild.id);
            const prevLeft = lMap.get(prevInviter) || 0;
            lMap.set(prevInviter, Math.max(0, prevLeft - 1));
            inviteLeaves.set(member.guild.id, lMap);
            scheduleSavePersistentState();
          }
        } catch (e) {
          console.warn("Error compensating leave on rejoin:", e);
        } finally {
          leaveRecords.delete(memberKey);
        }
      }

      // fetch current invites
      const currentInvites = await member.guild.invites
        .fetch()
        .catch(() => null);

      if (currentInvites) {
        // previous cached map (may be empty)
        const prevMap = guildInvites.get(member.guild.id) || new Map();

        // build new map & detect which invite increased
        const newMap = new Map();
        for (const inv of currentInvites.values()) {
          newMap.set(inv.code, inv.uses || 0);
        }

        for (const inv of currentInvites.values()) {
          const prevUses = prevMap.get(inv.code) || 0;
          const nowUses = inv.uses || 0;
          if (nowUses > prevUses) {
            inviterId = inv.inviter ? inv.inviter.id : null;
            countThisInvite = true;
            break;
          }
        }

        // update cache (always)
        guildInvites.set(member.guild.id, newMap);
      } else {
        console.warn(
          `[invites] Nie udało się pobrać invite'ów dla guild ${member.guild.id} — sprawdź uprawnienia bota (MANAGE_GUILD).`,
        );
      }
    } catch (e) {
      console.error("Błąd podczas wykrywania invite:", e);
    }

    // Simple fake-account detection (~1 month)
    try {
      const ACCOUNT_AGE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
      const accountAgeMs =
        Date.now() - (member.user.createdTimestamp || Date.now());
      isFakeAccount = accountAgeMs < ACCOUNT_AGE_THRESHOLD_MS;
      
      // Debug: loguj wiek konta
      const accountAgeDays = Math.floor(accountAgeMs / (24 * 60 * 60 * 1000));
      console.log(`[invite] Konto ${member.user.tag} (${member.id}) ma ${accountAgeDays} dni. Fake: ${isFakeAccount}`);
    } catch (e) {
      isFakeAccount = false;
    }

    // Rate-limit per inviter to avoid abuse (only if we detected inviter)
    if (inviterId && countThisInvite) {
      if (!inviterRateLimit.has(member.guild.id))
        inviterRateLimit.set(member.guild.id, new Map());
      const rateMap = inviterRateLimit.get(member.guild.id);
      if (!rateMap.has(inviterId)) rateMap.set(inviterId, []);
      const timestamps = rateMap.get(inviterId);

      const cutoff = Date.now() - INVITER_RATE_LIMIT_WINDOW_MS;
      const recent = timestamps.filter((t) => t > cutoff);
      recent.push(Date.now());
      rateMap.set(inviterId, recent);

      if (recent.length > INVITER_RATE_LIMIT_MAX) {
        // too many invites in the window -> mark as not counted
        countThisInvite = false;
        console.log(
          `[invites][ratelimit] Nie dodaję zaproszenia dla ${inviterId} - przekroczono limit w oknie.`,
        );
      }
    }

    // If we detected an inviter (even if not counted due to rate-limit, inviterId may be present)
    let fakeMap = null;
    const ownerId = "1305200545979437129";

    if (inviterId) {
      // Ensure all maps exist
      if (!inviteCounts.has(member.guild.id))
        inviteCounts.set(member.guild.id, new Map());
      if (!inviteRewards.has(member.guild.id))
        inviteRewards.set(member.guild.id, new Map());
      if (!inviteRewardsGiven.has(member.guild.id))
        inviteRewardsGiven.set(member.guild.id, new Map());
      if (!inviteLeaves.has(member.guild.id))
        inviteLeaves.set(member.guild.id, new Map());
      if (!inviteTotalJoined.has(member.guild.id))
        inviteTotalJoined.set(member.guild.id, new Map());
      if (!inviteFakeAccounts.has(member.guild.id))
        inviteFakeAccounts.set(member.guild.id, new Map());
      if (!inviteBonusInvites.has(member.guild.id))
        inviteBonusInvites.set(member.guild.id, new Map());

      const gMap = inviteCounts.get(member.guild.id); // prawdziwe zaproszenia
      const totalMap = inviteTotalJoined.get(member.guild.id); // wszystkie joiny
      fakeMap = inviteFakeAccounts.get(member.guild.id); // fake

      // Always increment totalJoined (wszystkie dołączenia przypisane do zapraszającego)
      const prevTotal = totalMap.get(inviterId) || 0;
      totalMap.set(inviterId, prevTotal + 1);

      // Liczymy zaproszenia tylko jeśli nie jest właścicielem
      if (inviterId !== ownerId) {
        // ZAWSZE liczymy zaproszenia z kont < 1 miesiąca
        if (!isFakeAccount) {
          const prev = gMap.get(inviterId) || 0;
          gMap.set(inviterId, prev + 1);
        }
      }

      // --- Nagrody za zaproszenia ---
      let rewardsGivenMap = inviteRewardsGiven.get(member.guild.id);
      if (!rewardsGivenMap) {
        rewardsGivenMap = new Map();
        inviteRewardsGiven.set(member.guild.id, rewardsGivenMap);
      }

      const alreadyGiven = rewardsGivenMap.get(inviterId) || 0;
      const currentCount = gMap.get(inviterId) || 0;

      // ile nagród powinno być przyznanych
      const eligibleRewards = Math.floor(
        currentCount / INVITE_REWARD_THRESHOLD,
      );
      const toGive = Math.max(0, eligibleRewards - alreadyGiven);

      if (toGive > 0) {
        rewardsGivenMap.set(inviterId, alreadyGiven + toGive);

        // Przygotuj kanał zaproszeń
        const zapCh =
          member.guild.channels.cache.find(
            (c) =>
              c.type === ChannelType.GuildText &&
              (c.name === "📨-×┃zaproszenia" ||
                c.name.toLowerCase().includes("zaproszen") ||
                c.name.toLowerCase().includes("zaproszenia")),
          ) || null;

        // Dla każdej nagrody
        for (let i = 0; i < toGive; i++) {
          const rewardCode = generateCode();
          const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 godziny
          const expiryTs = Math.floor(expiresAt / 1000);

          // Zapisz kod
          activeCodes.set(rewardCode, {
            oderId: inviterId,
            rewardAmount: 50000,
            rewardText: "50k$",
            expiresAt,
            used: false,
            type: "invite_cash",
          });

          // Wyślij DM
          try {
            const user = await client.users.fetch(inviterId);
            const dmEmbed = new EmbedBuilder()
              .setColor(0xd4af37)
              .setTitle("\`🔑\` Twój kod za zaproszenia")
              .setDescription(
                "```\n" +
                rewardCode +
                "\n```\n" +
                `> \`💸\` × **Otrzymałeś:** \`50k\$\`\n` +
                `> \`🕑\` × **Kod wygaśnie za:** <t:${expiryTs}:R> \n\n` +
                `> \`❔\` × Aby zrealizować kod utwórz nowy ticket, wybierz kategorię\n` +
                `> \`Odbiór nagrody\` i w polu wpisz otrzymany kod.`,
              )
              .setTimestamp();

            await user.send({ embeds: [dmEmbed] });
          } catch (e) {
            console.error("Błąd wysyłania DM z nagrodą:", e);
            // Fallback: wyślij na kanał zaproszeń
          }
        }
      }
    }

    // Jeśli konto jest fake (< 4 mies.), dodajemy tylko do licznika fake
    if (isFakeAccount && inviterId) {
      if (!inviteFakeAccounts.has(member.guild.id))
        inviteFakeAccounts.set(member.guild.id, new Map());
      const fakeMapLocal = fakeMap || inviteFakeAccounts.get(member.guild.id);
      const prevFake = fakeMapLocal.get(inviterId) || 0;
      fakeMapLocal.set(inviterId, prevFake + 1);
    }

    // store who invited this member (and whether it was counted)
    const memberKey = `${member.guild.id}:${member.id}`;
    inviterOfMember.set(memberKey, {
      inviterId,
      counted: !!(countThisInvite && !isFakeAccount),
      isFake: !!isFakeAccount,
    });

    // persist join/invite state
    scheduleSavePersistentState();

    // Powiadomienie na kanale zaproszeń kto kogo dodał
    const zapChannelId = "1449159392388972554";
    const zapChannel = member.guild.channels.cache.get(zapChannelId);

    if (zapChannel && inviterId) {
      const gMap = inviteCounts.get(member.guild.id) || new Map();
      const currentInvites = gMap.get(inviterId) || 0;
      const inviteWord = getInviteWord(currentInvites);
      const ownerId = "1305200545979437129";
      
      try {
        let message;
        if (inviterId === ownerId) {
          // Zaproszenie przez właściciela - nie liczymy zaproszeń
          message = `> \`✉️\` × <@${inviterId}> zaprosił <@${member.id}> (został zaproszony przez właściciela)`;
        } else {
          // Normalne zaproszenie
          message = isFakeAccount 
            ? `> \`✉️\` × <@${inviterId}> zaprosił <@${member.id}> i ma teraz **${currentInvites}** ${inviteWord}! (konto ma mniej niż 1mies)`
            : `> \`✉️\` × <@${inviterId}> zaprosił <@${member.id}> i ma teraz **${currentInvites}** ${inviteWord}!`;
        }
        await zapChannel.send(message);
      } catch (e) { }
    }

    // Send welcome embed (no inviter details here)
    if (ch) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_BLUE)
        .setDescription(
          "```\n" +
          "👋 New Shop × LOBBY\n" +
          "```\n" +
          `> \`😎\` **Witaj \`${member.user.username}\` na __NEW SHOP!__**\n` +
          `> \`🧑‍🤝‍🧑\` **Jesteś \`${member.guild.memberCount}\` osobą na naszym serwerze!**\n` +
          `> \`✨\` **Liczymy, że zostaniesz z nami na dłużej!**`,
        )
        .setThumbnail(
          member.user.displayAvatarURL({ dynamic: true, size: 256 }),
        )
        .setTimestamp();

      await ch.send({ content: `<@${member.id}>`, embeds: [embed] });
    } else if (member.guild.systemChannel) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_BLUE)
        .setDescription(
          "```\n" +
          "👋 New Shop × LOBBY\n" +
          "```\n" +
          `> \`😎\` **Witaj \`${member.user.username}\` na __NEW SHOP!__**\n` +
          `> \`🧑‍🤝‍🧑\` **Jesteś \`${member.guild.memberCount}\` osobą na naszym serwerze!**\n` +
          `> \`✨\` **Liczymy, że zostaniesz z nami na dłużej!**`,
        )
        .setThumbnail(
          member.user.displayAvatarURL({ dynamic: true, size: 256 }),
        )
        .setTimestamp();

      await member.guild.systemChannel
        .send({ content: `<@${member.id}>`, embeds: [embed] })
        .catch(() => null);
    }
  } catch (err) {
    console.error("Błąd wysyłania powitania / invite tracking:", err);
  }
});

// decrement inviter count on leave if we tracked who invited them
client.on(Events.GuildMemberRemove, async (member) => {
  try {
    const key = `${member.guild.id}:${member.id}`;
    const stored = inviterOfMember.get(key);
    if (!stored) return;

    // backward-compat: jeżeli stary format (string), zamieniamy na obiekt
    let inviterId, counted, wasFake;
    if (typeof stored === "string") {
      inviterId = stored;
      counted = true; // zakładamy, że wcześniej był liczony
      wasFake = false;
    } else {
      inviterId = stored.inviterId;
      counted = !!stored.counted;
      wasFake = !!stored.isFake;
    }

    if (!inviterId) {
      inviterOfMember.delete(key);
      return;
    }

    // decrement inviteCounts for inviter (if present AND if this invite was counted)
    if (!inviteCounts.has(member.guild.id))
      inviteCounts.set(member.guild.id, new Map());
    const gMap = inviteCounts.get(member.guild.id);
    const ownerId = "1305200545979437129";
    
    // Odejmujemy zaproszenia tylko jeśli nie jest właścicielem
    if (counted && inviterId !== ownerId) {
      const prev = gMap.get(inviterId) || 0;
      const newCount = Math.max(0, prev - 1);
      gMap.set(inviterId, newCount);
    }

    // decrement totalJoined (since we incremented it on join unconditionally)
    if (!inviteTotalJoined.has(member.guild.id))
      inviteTotalJoined.set(member.guild.id, new Map());
    const totalMap = inviteTotalJoined.get(member.guild.id);
    const prevTotal = totalMap.get(inviterId) || 0;
    totalMap.set(inviterId, Math.max(0, prevTotal - 1));

    // If it was marked as fake on join, decrement fake counter
    if (wasFake) {
      if (!inviteFakeAccounts.has(member.guild.id))
        inviteFakeAccounts.set(member.guild.id, new Map());
      const fMap = inviteFakeAccounts.get(member.guild.id);
      const prevFake = fMap.get(inviterId) || 0;
      fMap.set(inviterId, Math.max(0, prevFake - 1));
    }

    // increment leaves count
    if (!inviteLeaves.has(member.guild.id))
      inviteLeaves.set(member.guild.id, new Map());
    const lMap = inviteLeaves.get(member.guild.id);
    const prevLeft = lMap.get(inviterId) || 0;
    lMap.set(inviterId, prevLeft + 1);

    // Zapisz do leaveRecords na wypadek powrotu
    leaveRecords.set(key, inviterId);

    // remove mapping
    inviterOfMember.delete(key);

    // persist invite + leave stan
    scheduleSavePersistentState();

    // notify zaproszenia channel
    const zapCh =
      member.guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildText &&
          (c.name === "📨-×┃zaproszenia" ||
            c.name.toLowerCase().includes("zaproszen") ||
            c.name.toLowerCase().includes("zaproszenia")),
      ) || null;

    if (zapCh) {
      // compute newCount for message (inviteCounts after possible decrement)
      const currentCount = gMap.get(inviterId) || 0;
      const inviteWord = getInviteWord(currentCount);
      const ownerId = "1305200545979437129";
      
      try {
        let message;
        if (inviterId === ownerId) {
          // Opuszczenie przez zaproszenie właściciela - nie odejmowaliśmy zaproszeń
          message = `> \`🚪\` × <@${member.id}> opuścił serwer. (Był zaproszony przez właściciela)`;
        } else {
          // Normalne opuszczenie
          message = `> \`🚪\` × <@${member.id}> opuścił serwer. Był zaproszony przez <@${inviterId}> który ma teraz **${currentCount}** ${inviteWord}.`;
        }
        await zapCh.send(message);
      } catch (e) { }
    }

    console.log(
      `Odejmuję zaproszenie od ${inviterId} po leave (counted=${counted}, wasFake=${wasFake}).`,
    );
  } catch (err) {
    console.error("Błąd przy obsłudze odejścia członka:", err);
  }
});

// ----------------- /sprawdz-zaproszenia command handler -----------------
async function handleSprawdzZaproszeniaCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "❌ Tylko na serwerze.",
      ephemeral: true,
    });
    return;
  }

  const SPRAWDZ_ZAPROSZENIA_CHANNEL_ID = "1449159417445482566";
  if (interaction.channelId !== SPRAWDZ_ZAPROSZENIA_CHANNEL_ID) {
    await interaction.reply({
      content: `❌ Użyj tej komendy na kanale <#${SPRAWDZ_ZAPROSZENIA_CHANNEL_ID}>.`,
      ephemeral: true,
    });
    return;
  }

  // cooldown 30s
  const nowTs = Date.now();
  const lastTs = sprawdzZaproszeniaCooldowns.get(interaction.user.id) || 0;
  if (nowTs - lastTs < 30_000) {
    const remain = Math.ceil((30_000 - (nowTs - lastTs)) / 1000);
    await interaction.reply({
      content: `❌ Poczekaj jeszcze ${remain}s zanim użyjesz /sprawdz-zaproszenia ponownie.`,
      ephemeral: true,
    });
    return;
  }
  sprawdzZaproszeniaCooldowns.set(interaction.user.id, nowTs);

  // Defer to avoid timeout and allow multiple replies
  await interaction.deferReply({ ephemeral: false }).catch(() => null);

  // ===== SPRAWDZ-ZAPROSZENIA – PEŁNY SCRIPT =====

  const preferChannel = interaction.guild.channels.cache.get(SPRAWDZ_ZAPROSZENIA_CHANNEL_ID);
  const guildId = interaction.guild.id;

  // Inicjalizacja map
  if (!inviteCounts.has(guildId)) inviteCounts.set(guildId, new Map());
  if (!inviteRewards.has(guildId)) inviteRewards.set(guildId, new Map());
  if (!inviteRewardsGiven.has(guildId)) inviteRewardsGiven.set(guildId, new Map());
  if (!inviteLeaves.has(guildId)) inviteLeaves.set(guildId, new Map());
  if (!inviteTotalJoined.has(guildId)) inviteTotalJoined.set(guildId, new Map());
  if (!inviteFakeAccounts.has(guildId)) inviteFakeAccounts.set(guildId, new Map());
  if (!inviteBonusInvites.has(guildId)) inviteBonusInvites.set(guildId, new Map());

  // Mapy gildii
  const gMap = inviteCounts.get(guildId);
  const totalMap = inviteTotalJoined.get(guildId);
  const fakeMap = inviteFakeAccounts.get(guildId);
  const lMap = inviteLeaves.get(guildId);
  const bonusMap = inviteBonusInvites.get(guildId);

  // Dane użytkownika
  const userId = interaction.user.id;
  const validInvites = gMap.get(userId) || 0;
  const left = lMap.get(userId) || 0;
  const fake = fakeMap.get(userId) || 0;
  const bonus = bonusMap.get(userId) || 0;

  // Zaproszenia wyświetlane (z bonusem)
  const displayedInvites = validInvites + bonus;
  const inviteWord = getInviteWord(displayedInvites);

  // Brakujące do nagrody
  let missingToReward = INVITE_REWARD_THRESHOLD - (displayedInvites % INVITE_REWARD_THRESHOLD);
  if (displayedInvites !== 0 && displayedInvites % INVITE_REWARD_THRESHOLD === 0) {
    missingToReward = 0;
  }

  // Embed
  const embed = new EmbedBuilder()
    .setColor(COLOR_BLUE)
    .setDescription(
      `\n` +
      `📩 **New Shop × ZAPROSZENIA**\n\n` +
      `> 👤 × <@${userId}> **posiada** **${displayedInvites} ${inviteWord}**!\n\n` +
      `> 💸 × **Brakuje ci zaproszeń do nagrody \`${INVITE_REWARD_TEXT}:** ${missingToReward}\n\n` +
      `> 👥 × **Prawdziwe osoby które dołączyły:** ${displayedInvites}\n` +
      `> 🚶 × **Osoby które opuściły serwer:** ${left}\n` +
      `> ⚠️ × **Niespełniające kryteriów (< konto 1 mies.):** ${fake}\n` +
      `> 🎁 × **Dodatkowe zaproszenia:** ${bonus}`
    );

  try {
    // Kanał docelowy
    const targetChannel = preferChannel ? preferChannel : interaction.channel;

    // Publikacja embeda
    await targetChannel.send({ embeds: [embed] });

    // Odświeżanie instrukcji
    try {
      const zapCh = targetChannel;
      if (zapCh && zapCh.id) {
        const prevId = lastInviteInstruction.get(zapCh.id);
        if (prevId) {
          const prevMsg = await zapCh.messages.fetch(prevId).catch(() => null);
          if (prevMsg && prevMsg.deletable) {
            await prevMsg.delete().catch(() => null);
          }
          lastInviteInstruction.delete(zapCh.id);
        }

        const instructionInviteEmbed = new EmbedBuilder()
          .setColor(0xffffff)
          .setDescription(
            `📩 Użyj komendy </sprawdz-zaproszenia:1454974443179868263> aby sprawdzić swoje zaproszenia!`
          );

        const sent = await zapCh.send({ embeds: [instructionInviteEmbed] });
        lastInviteInstruction.set(zapCh.id, sent.id);
        scheduleSavePersistentState();
      }
    } catch (e) {
      console.warn("Nie udało się odświeżyć instrukcji zaproszeń:", e);
    }

    await interaction.editReply({
      content: "✅ Informacje o twoich zaproszeniach zostały wysłane.",
    });

  } catch (err) {
    console.error("Błąd przy publikacji sprawdz-zaproszenia:", err);
    try {
      await interaction.editReply({ embeds: [embed] });
    } catch {
      await interaction.editReply({
        content: "❌ Nie udało się opublikować informacji o zaproszeniach.",
      });
    }
  }
}

// ---------------------------------------------------
// Nowa komenda: /zaproszeniastats
async function handleZaprosieniaStatsCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "❌ Ta komenda działa tylko na serwerze.",
      ephemeral: true,
    });
    return;
  }

  const member = interaction.member;
  const isAdmin =
    member &&
    member.permissions &&
    (member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild));
  if (!isAdmin) {
    await interaction.reply({
      content: "❌ Nie masz uprawnień administracyjnych.",
      ephemeral: true,
    });
    return;
  }

  const categoryRaw = (
    interaction.options.getString("kategoria") || ""
  ).toLowerCase();
  const action = (interaction.options.getString("akcja") || "").toLowerCase();
  const number = Math.max(0, interaction.options.getInteger("liczba") || 0);
  const user = interaction.options.getUser("komu") || interaction.user;
  const guildId = interaction.guild.id;

  // normalize category aliases
  let category = null;
  if (["prawdziwe", "prawdziwy", "prawdzi"].includes(categoryRaw))
    category = "prawdziwe";
  else if (
    ["opuszczone", "opuśćone", "opuszcone", "left", "lefts"].includes(
      categoryRaw,
    )
  )
    category = "opuszczone";
  else if (
    [
      "mniej4mies",
      "mniejniż4mies",
      "mniej_niz_4mies",
      "mniej",
      "mniej4",
    ].includes(categoryRaw)
  )
    category = "mniej4mies";
  else if (["dodatkowe", "dodatkowa", "bonus", "bonusy"].includes(categoryRaw))
    category = "dodatkowe";

  if (!category) {
    await interaction.reply({
      content:
        "❌ Nieznana kategoria. Wybierz: `prawdziwe`, `opuszczone`, `mniej4mies`, `dodatkowe`.",
      ephemeral: true,
    });
    return;
  }

  // ensure maps exist
  if (!inviteCounts.has(guildId)) inviteCounts.set(guildId, new Map());
  if (!inviteLeaves.has(guildId)) inviteLeaves.set(guildId, new Map());
  if (!inviteFakeAccounts.has(guildId))
    inviteFakeAccounts.set(guildId, new Map());
  if (!inviteBonusInvites.has(guildId))
    inviteBonusInvites.set(guildId, new Map());
  if (!inviteRewards.has(guildId)) inviteRewards.set(guildId, new Map());
  if (!inviteRewardsGiven.has(guildId))
    inviteRewardsGiven.set(guildId, new Map());

  let targetMap;
  let prettyName;
  switch (category) {
    case "prawdziwe":
      targetMap = inviteCounts.get(guildId);
      prettyName = "Prawdziwe (policzone) zaproszenia";
      break;
    case "opuszczone":
      targetMap = inviteLeaves.get(guildId);
      prettyName = "Osoby, które opuściły serwer";
      break;
    case "mniej4mies":
      targetMap = inviteFakeAccounts.get(guildId);
      prettyName = "Niespełniające kryteriów (< konto 4 mies.)";
      break;
    case "dodatkowe":
      targetMap = inviteBonusInvites.get(guildId);
      prettyName = "Dodatkowe zaproszenia";
      break;
    default:
      targetMap = inviteCounts.get(guildId);
      prettyName = category;
  }

  const prev = targetMap.get(user.id) || 0;
  let newVal = prev;

  if (action === "dodaj") {
    newVal = prev + number;
  } else if (action === "odejmij") {
    newVal = Math.max(0, prev - number);
  } else if (action === "ustaw") {
    newVal = Math.max(0, number);
  } else if (action === "wyczysc" || action === "czysc" || action === "reset") {
    newVal = 0;
  } else {
    await interaction.reply({
      content:
        "❌ Nieznana akcja. Wybierz: `dodaj`, `odejmij`, `ustaw`, `wyczysc`.",
      ephemeral: true,
    });
    return;
  }

  // BEFORE saving: jeśli edytujemy "prawdziwe", sprawdź czy osiągnięto próg i przyznaj nagrody
  if (category === "prawdziwe") {
    // Sprawdź ile pełnych progów (5) jest w newVal
    const rewardsToGive = Math.floor(newVal / INVITE_REWARD_THRESHOLD);

    // Sprawdź ile już przyznaliśmy
    const rewardsGivenMap = inviteRewardsGiven.get(guildId) || new Map();
    const alreadyGiven = rewardsGivenMap.get(user.id) || 0;

    // Ile nowych nagród do przyznania
    const newRewards = Math.max(0, rewardsToGive - alreadyGiven);

    if (newRewards > 0) {
      // Przyznajemy nowe nagrody
      const rMap = inviteRewards.get(guildId) || new Map();
      inviteRewards.set(guildId, rMap);

      const generatedCodes = [];

      for (let i = 0; i < newRewards; i++) {
        const rewardCode = generateCode();
        const CODE_EXPIRES_MS = 24 * 60 * 60 * 1000;
        const expiresAt = Date.now() + CODE_EXPIRES_MS;

        activeCodes.set(rewardCode, {
          oderId: user.id,
          discount: 0,
          expiresAt,
          used: false,
          reward: INVITE_REWARD_TEXT,
          type: "invite_reward",
        });

        generatedCodes.push(rewardCode);
      }

      // Zaktualizuj liczbę przyznanych nagród
      rewardsGivenMap.set(user.id, alreadyGiven + newRewards);
      inviteRewardsGiven.set(guildId, rewardsGivenMap);

      // Przygotuj kanał zaproszeń
      const zapCh =
        interaction.guild.channels.cache.find(
          (c) =>
            c.type === ChannelType.GuildText &&
            (c.name === "📨-×┃zaproszenia" ||
              c.name.toLowerCase().includes("zaproszen") ||
              c.name.toLowerCase().includes("zaproszenia")),
        ) || null;

      // Wyślij DM z kodami
      try {
        const u = await client.users.fetch(user.id);
        const codesList = generatedCodes.join("\n");
        const expiresAtSeconds = Math.floor(
          (Date.now() + 24 * 60 * 60 * 1000) / 1000,
        );

        const dmEmbed = new EmbedBuilder()
          .setColor(0xd4af37)
          .setTitle("\`🔑\` Twój kod za zaproszenia")
          .setDescription(
            "```\n" +
            codesList +
            "\n```\n" +
            `> \`💸\` × **Otrzymałeś:** \`${INVITE_REWARD_TEXT}\`\n` +
            `> \`🕑\` × **Kod wygaśnie za:** <t:${expiresAtSeconds}:R> \n\n` +
            `> \`❔\` × Aby zrealizować kod utwórz nowy ticket, wybierz kategorię\n` +
            `> \`Odbiór nagrody\` i w polu wpisz otrzymany kod.`,
          )
          .setTimestamp();

        await u.send({ embeds: [dmEmbed] }).catch(async () => {
          // fallback: opublikuj kody w zaproszenia channel jako spoilery
          if (zapCh) {
            try {
              const spoilers = generatedCodes
                .map((c) => `||\`${c}\`||`)
                .join(" ");
              await zapCh
                .send({
                  content: `🎉 <@${user.id}> otrzymał nagrodę ${INVITE_REWARD_TEXT}! Kody: ${spoilers} (jeśli nie otrzymałeś DM, sprawdź tutaj).`,
                })
                .catch(() => null);
            } catch (e) { }
          }
        });

        // Powiadomienie publiczne
      } catch (e) {
        console.error("Błąd wysyłania DM z nagrodą:", e);
      }
    }
  }

  // finally set the (possibly adjusted) value
  targetMap.set(user.id, newVal);
  scheduleSavePersistentState();

  await interaction.reply({
    content: `✅ Zaktualizowano **${prettyName}** dla <@${user.id}>: \`${prev}\` → \`${newVal}\`.`,
    ephemeral: true,
  });
}

// ---------------------------------------------------
// Pomoc
async function handleHelpCommand(interaction) {
  try {
    const embed = new EmbedBuilder()
      .setColor(COLOR_BLUE)
      .setTitle("Pomoc — komendy bota")
      .setDescription(
        [
          "`/drop` — Wylosuj zniżkę",
          "`/ticket` — Utwórz ticket",
          "`/ticketpanel` — Wyślij panel ticketów",
          "`/opiniekanal` — Ustaw kanał opinii (admin)",
          "`/opinia` — Wystaw opinię (na kanale opinii)",
          "`/zamknij` — Zamknij ticket (admin)",
          "`/help` — Pokaż tę wiadomość",
        ].join("\n"),
      )
      .setTimestamp();

    // reply ephemeral so tylko użytkownik widzi
    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (err) {
    console.error("handleHelpCommand error:", err);
    try {
      await interaction.reply({
        content: "❌ Błąd podczas wyświetlania pomocy.",
        ephemeral: true,
      });
    } catch (e) { }
  }
}

// Parser czasu: 1h = 1 godzina, 1d = 1 dzień, 1m = 1 minuta, 1s = 1 sekunda
function parseTimeString(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return null;
  const trimmed = timeStr.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)([hdms])$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (isNaN(value) || value <= 0) return null;

  switch (unit) {
    case "s":
      return value * 1000; // sekundy -> ms
    case "m":
      return value * 60 * 1000; // minuty -> ms
    case "h":
      return value * 60 * 60 * 1000; // godziny -> ms
    case "d":
      return value * 24 * 60 * 60 * 1000; // dni -> ms
    default:
      return null;
  }
}

// --- Pomocnicze: formatowanie pozostałego czasu ---
function formatTimeDelta(ms) {
  const timestamp = Math.floor((Date.now() + ms) / 1000);
  return `<t:${timestamp}:R>`;
}

// --- Pomocnicze: poprawna forma liczby osób ---
function getPersonForm(count) {
  if (count === 1) return "osoba";
  if (
    count % 10 >= 2 &&
    count % 10 <= 4 &&
    (count % 100 < 10 || count % 100 >= 20)
  ) {
    return "osoby";
  }
  return "osób";
}

// --- Pomocnicze: losowanie zwycięzców ---
function pickRandom(arr, n) {
  if (!arr || !arr.length) return [];
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// ----------------- /dodajkonkurs handler (poprawiona wersja) -----------------
async function handleDodajKonkursCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "❌ Tylko na serwerze.",
      ephemeral: true,
    });
    return;
  }
  // permission check
  const member = interaction.member;
  const isAdmin =
    member &&
    member.permissions &&
    (member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild));
  if (!isAdmin) {
    await interaction.reply({
      content: "❌ Nie masz uprawnień administracyjnych.",
      ephemeral: true,
    });
    return;
  }

  // Modal: tylko nagroda (jako tytuł), czas, zwycięzcy i wymagane zaproszenia
  const modal = new ModalBuilder()
    .setCustomId("konkurs_create_modal")
    .setTitle("Utwórz konkurs");

  const prizeInput = new TextInputBuilder()
    .setCustomId("konkurs_nagroda")
    .setLabel("Nagroda (to będzie tytuł konkursu)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(200);

  const timeInput = new TextInputBuilder()
    .setCustomId("konkurs_czas")
    .setLabel("Czas trwania (np. 1h, 2d, 30m, 60s)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("h = godzina, m = minuta, d = dzień, s = sekunda")
    .setMaxLength(10);

  const winnersInput = new TextInputBuilder()
    .setCustomId("konkurs_zwyciezcy")
    .setLabel("Liczba zwycięzców")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("1")
    .setMaxLength(3);

  const invitesReqInput = new TextInputBuilder()
    .setCustomId("konkurs_wymagania_zaproszenia")
    .setLabel("Wymagane zaproszenia (opcjonalnie)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("2")
    .setMaxLength(5);

  modal.addComponents(
    new ActionRowBuilder().addComponents(prizeInput),
    new ActionRowBuilder().addComponents(timeInput),
    new ActionRowBuilder().addComponents(winnersInput),
    new ActionRowBuilder().addComponents(invitesReqInput),
  );

  await interaction.showModal(modal);
}

async function handleKonkursCreateModal(interaction) {
  const prize = interaction.fields.getTextInputValue("konkurs_nagroda");
  const timeStr = interaction.fields.getTextInputValue("konkurs_czas");
  const winnersStr =
    interaction.fields.getTextInputValue("konkurs_zwyciezcy") || "1";
  const invitesReqStr =
    interaction.fields.getTextInputValue("konkurs_wymagania_zaproszenia") || "";

  const timeMs = parseTimeString(timeStr);
  if (!timeMs) {
    await interaction.reply({
      content:
        "❌ Nieprawidłowy format czasu. Użyj np. `1h`, `2d`, `30m`, `60s`",
      ephemeral: true,
    });
    return;
  }

  const winnersCount = Math.max(1, parseInt(winnersStr, 10) || 1);
  const invitesRequired = invitesReqStr.trim()
    ? Math.max(0, parseInt(invitesReqStr.trim(), 10) || 0)
    : 0;

  let targetChannel = interaction.channel;
  await interaction.deferReply({ ephemeral: true }).catch(() => { });

  const endsAt = Date.now() + timeMs;
  const ts = Math.floor(endsAt / 1000);

  // Początkowy opis z wymaganiami zaproszeń jeśli są
  let description =
    `Liczba zwycięzców: ${winnersCount}\n` +
    `Czas do końca konkursu: ${formatTimeDelta(timeMs)}\n` +
    `Liczba uczestników: 0\n` +
    `Nagroda: ${prize}`;

  if (invitesRequired > 0) {
    const inviteForm = getPersonForm(invitesRequired);
    description += `\n\n⚠️ Wymagane: dodać ${invitesRequired} ${inviteForm} na serwer`;
  }

  // Początkowy embed
  const embed = new EmbedBuilder()
    .setTitle(`${prize}`)
    .setColor(0xffa500)
    .setDescription(description)
    .setTimestamp();

  // Placeholder button (will be replaced with proper customId after message is sent)
  const joinBtn = new ButtonBuilder()
    .setCustomId("konkurs_join_pending")
    .setLabel("Weź udział (0)")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(false);

  let sent = null;

  // Dodaj GIF przy tworzeniu konkursu
  try {
    const gifPath = path.join(
      __dirname,
      "attached_assets",
      "standard (4).gif",
    );
    const attachment = new AttachmentBuilder(gifPath, { name: "konkurs_start.gif" });
    embed.setImage("attachment://konkurs_start.gif");
    
    const row = new ActionRowBuilder().addComponents(joinBtn);
    sent = await targetChannel.send({ 
      embeds: [embed], 
      components: [row],
      files: [attachment]  // ✅ Pierwsze wysłanie - musi mieć files
    });
  } catch (err) {
    console.warn("Nie udało się załadować GIFa przy tworzeniu konkursu:", err);
    // Fallback: wyślij bez GIFa
    const row = new ActionRowBuilder().addComponents(joinBtn);
    sent = await targetChannel.send({ 
      embeds: [embed], 
      components: [row]
    });
  }

  if (!sent) {
    try {
      await interaction.editReply({
        content: "❌ Nie udało się utworzyć konkursu (nie wysłano wiadomości w kanał).",
      });
    } catch (e) {
      // ignore
    }
    return;
  }

  contests.set(sent.id, {
    channelId: targetChannel.id,
    endsAt,
    winnersCount,
    title: prize,
    prize,
    messageId: sent.id,
    createdBy: interaction.user.id,
    invitesRequired,
  });

  contestParticipants.set(sent.id, new Map());
  scheduleSavePersistentState();

  // ustawiamy poprawny id na przycisku już po wysłaniu
  const properCustomId = `konkurs_join_${sent.id}`;
  const joinButtonCorrect = new ButtonBuilder()
    .setCustomId(properCustomId)
    .setLabel("Weź udział (0)")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(false);

  const newRow = new ActionRowBuilder().addComponents(joinButtonCorrect);
  await sent.edit({ components: [newRow] }).catch(() => null);

  setTimeout(() => {
    endContestByMessageId(sent.id).catch((e) => console.error(e));
  }, timeMs);

  try {
    await interaction.editReply({
      content: `✅ Konkurs opublikowany w <#${targetChannel.id}> i potrwa ${formatTimeDelta(timeMs)} (do <t:${ts}:R>)`,
    });
  } catch (err) {
    console.error("Błąd tworzenia konkursu:", err);
    try {
      await interaction.editReply({
        content: "❌ Nie udało się utworzyć konkursu.",
      });
    } catch (e) {
      console.error("Nie udało się wysłać editReply po błędzie:", e);
    }
  }
}

// ----------------- /dodajkonkurs handler (poprawiona wersja) -----------------
async function handleDodajKonkursCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "❌ Tylko na serwerze.",
      ephemeral: true,
    });
    return;
  }
  // permission check
  const member = interaction.member;
  const isAdmin =
    member &&
    member.permissions &&
    (member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild));
  if (!isAdmin) {
    await interaction.reply({
      content: "❌ Nie masz uprawnień administracyjnych.",
      ephemeral: true,
    });
    return;
  }

  // Modal: tylko nagroda (jako tytuł), czas, zwycięzcy i wymagane zaproszenia
  const modal = new ModalBuilder()
    .setCustomId("konkurs_create_modal")
    .setTitle("Utwórz konkurs");

  const prizeInput = new TextInputBuilder()
    .setCustomId("konkurs_nagroda")
    .setLabel("Nagroda (to będzie tytuł konkursu)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(200);

  const timeInput = new TextInputBuilder()
    .setCustomId("konkurs_czas")
    .setLabel("Czas trwania (np. 1h, 2d, 30m, 60s)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("h = godzina, m = minuta, d = dzień, s = sekunda")
    .setMaxLength(10);

  const winnersInput = new TextInputBuilder()
    .setCustomId("konkurs_zwyciezcy")
    .setLabel("Liczba zwycięzców")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("1")
    .setMaxLength(3);

  const invitesReqInput = new TextInputBuilder()
    .setCustomId("konkurs_wymagania_zaproszenia")
    .setLabel("Wymagane zaproszenia (opcjonalnie)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("2")
    .setMaxLength(5);

  modal.addComponents(
    new ActionRowBuilder().addComponents(prizeInput),
    new ActionRowBuilder().addComponents(timeInput),
    new ActionRowBuilder().addComponents(winnersInput),
    new ActionRowBuilder().addComponents(invitesReqInput),
  );

  await interaction.showModal(modal);
}

async function handleKonkursCreateModal(interaction) {
  const prize = interaction.fields.getTextInputValue("konkurs_nagroda");
  const timeStr = interaction.fields.getTextInputValue("konkurs_czas");
  const winnersStr =
    interaction.fields.getTextInputValue("konkurs_zwyciezcy") || "1";
  const invitesReqStr =
    interaction.fields.getTextInputValue("konkurs_wymagania_zaproszenia") || "";

  const timeMs = parseTimeString(timeStr);
  if (!timeMs) {
    await interaction.reply({
      content:
        "❌ Nieprawidłowy format czasu. Użyj np. `1h`, `2d`, `30m`, `60s`",
      ephemeral: true,
    });
    return;
  }

  const winnersCount = Math.max(1, parseInt(winnersStr, 10) || 1);
  const invitesRequired = invitesReqStr.trim()
    ? Math.max(0, parseInt(invitesReqStr.trim(), 10) || 0)
    : 0;

  let targetChannel = interaction.channel;
  await interaction.deferReply({ ephemeral: true }).catch(() => { });

  const endsAt = Date.now() + timeMs;
  const ts = Math.floor(endsAt / 1000);

  // Początkowy opis z wymaganiami zaproszeń jeśli są
  let description =
    `Liczba zwycięzców: ${winnersCount}\n` +
    `Czas do końca konkursu: ${formatTimeDelta(timeMs)}\n` +
    `Liczba uczestników: 0\n` +
    `Nagroda: ${prize}`;

  if (invitesRequired > 0) {
    const inviteForm = getPersonForm(invitesRequired);
    description += `\n\n⚠️ Wymagane: dodać ${invitesRequired} ${inviteForm} na serwer`;
  }

  // Początkowy embed
  const embed = new EmbedBuilder()
    .setTitle(`${prize}`)
    .setColor(0xffa500)
    .setDescription(description)
    .setTimestamp();

  // Placeholder button (will be replaced with proper customId after message is sent)
  const joinBtn = new ButtonBuilder()
    .setCustomId("konkurs_join_pending")
    .setLabel("Weź udział (0)")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(false);

  let sent = null;

  // Dodaj GIF przy tworzeniu konkursu
  try {
    const gifPath = path.join(
      __dirname,
      "attached_assets",
      "standard (4).gif",
    );
    const attachment = new AttachmentBuilder(gifPath, { name: "konkurs_start.gif" });
    embed.setImage("attachment://konkurs_start.gif");
    
    const row = new ActionRowBuilder().addComponents(joinBtn);
    sent = await targetChannel.send({ 
      embeds: [embed], 
      components: [row],
      files: [attachment]
    });
  } catch (err) {
    console.warn("Nie udało się załadować GIFa przy tworzeniu konkursu:", err);
    // Fallback: wyślij bez GIFa
    const row = new ActionRowBuilder().addComponents(joinBtn);
    sent = await targetChannel.send({ 
      embeds: [embed], 
      components: [row]
    });
  }

  if (!sent) {
    try {
      await interaction.editReply({
        content: "❌ Nie udało się utworzyć konkursu (nie wysłano wiadomości w kanał).",
      });
    } catch (e) {
      // ignore
    }
    return;
  }

  contests.set(sent.id, {
    channelId: targetChannel.id,
    endsAt,
    winnersCount,
    title: prize,
    prize,
    messageId: sent.id,
    createdBy: interaction.user.id,
    invitesRequired,
  });

  contestParticipants.set(sent.id, new Map());
  scheduleSavePersistentState();

  // ustawiamy poprawny id na przycisku już po wysłaniu
  const properCustomId = `konkurs_join_${sent.id}`;
  const joinButtonCorrect = new ButtonBuilder()
    .setCustomId(properCustomId)
    .setLabel("Weź udział (0)")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(false);

  const newRow = new ActionRowBuilder().addComponents(joinButtonCorrect);
  await sent.edit({ components: [newRow] }).catch(() => null);

  setTimeout(() => {
    endContestByMessageId(sent.id).catch((e) => console.error(e));
  }, timeMs);

  try {
    await interaction.editReply({
      content: `✅ Konkurs opublikowany w <#${targetChannel.id}> i potrwa ${formatTimeDelta(timeMs)} (do <t:${ts}:R>)`,
    });
  } catch (err) {
    console.error("Błąd tworzenia konkursu:", err);
    try {
      await interaction.editReply({
        content: "❌ Nie udało się utworzyć konkursu.",
      });
    } catch (e) {
      console.error("Nie udało się wysłać editReply po błędzie:", e);
    }
  }
}

async function handleKonkursJoinModal(interaction, msgId) {
  const contest = contests.get(msgId);
  if (!contest) {
    await interaction.reply({
      content: "❌ Konkurs nie został znaleziony.",
      ephemeral: true,
    });
    return;
  }
  if (Date.now() >= contest.endsAt) {
    await interaction.reply({
      content: "❌ Konkurs już się zakończył.",
      ephemeral: true,
    });
    return;
  }

  if (contest.invitesRequired > 0) {
    const gMap = inviteCounts.get(interaction.guild.id) || new Map();
    const userInvites = gMap.get(interaction.user.id) || 0;
    if (userInvites < contest.invitesRequired) {
      await interaction.reply({
        content: `❌ Nie masz wystarczającej liczby zaproszeń. Wymagane: ${contest.invitesRequired}`,
        ephemeral: true,
      });
      return;
    }
  }

  let nick = "";
  try {
    nick = (interaction.fields.getTextInputValue("konkurs_nick") || "").trim();
  } catch (e) {
    nick = "";
  }

  let participantsMap = contestParticipants.get(msgId);
  if (!participantsMap) {
    participantsMap = new Map();
    contestParticipants.set(msgId, participantsMap);
  }

  const userId = interaction.user.id;
  if (participantsMap.has(userId)) {
    // Użytkownik już bierze udział - pytamy czy chce opuścić konkurs
    const leaveButton = new ButtonBuilder()
      .setCustomId(`konkurs_leave_${msgId}`)
      .setLabel("Opuść")
      .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
      .setCustomId(`konkurs_cancel_leave_${msgId}`)
      .setLabel("Anuluj")
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(leaveButton, cancelButton);

    await interaction.reply({
      content: "❓ Czy chcesz opuścić konkurs?",
      components: [row],
      ephemeral: true,
    });
    return;
  }

  participantsMap.set(userId, nick);
  scheduleSavePersistentState();

  const participantsCount = participantsMap.size;

  // Aktualizuj wiadomość konkursu
  try {
    const ch = await client.channels.fetch(contest.channelId).catch(() => null);
    if (ch) {
      const origMsg = await ch.messages.fetch(msgId).catch(() => null);
      if (origMsg) {
        // Zaktualizuj opis
        let updatedDescription =
          `Liczba zwycięzców: ${contest.winnersCount}\n` +
          `Czas do końca konkursu: ${formatTimeDelta(contest.endsAt - Date.now())}\n` +
          `Liczba uczestników: ${participantsCount}\n` +
          `Nagroda: ${contest.prize}`;

        if (contest.invitesRequired > 0) {
          const inviteForm = getPersonForm(contest.invitesRequired);
          updatedDescription += `\n\n⚠️ Wymagane: dodać ${contest.invitesRequired} ${inviteForm} na serwer`;
        }

        // Pobierz istniejący embed i zaktualizuj TYLKO description
        const existingEmbed = EmbedBuilder.from(origMsg.embeds[0]);
        existingEmbed.setDescription(updatedDescription);

        // Zaktualizuj przycisk
        const joinButton = new ButtonBuilder()
          .setCustomId(`konkurs_join_${msgId}`)
          .setLabel(`Weź udział (${participantsCount})`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(false);
        const row = new ActionRowBuilder().addComponents(joinButton);

        // Edytuj wiadomość BEZ files - zostaw embed taki jaki jest (z GIFem)
        await origMsg.edit({ 
          embeds: [existingEmbed], 
          components: [row] 
        }).catch(() => null);
      }
    }
  } catch (e) {
    console.warn("Nie udało się zaktualizować embed/btn konkursu:", e);
  }

  await interaction.reply({
    content: `✅ Jesteś zapisany do konkursu. Uczestników: ${participantsCount}`,
    ephemeral: true,
  });
}

async function endContestByMessageId(messageId) {
  const meta = contests.get(messageId);
  if (!meta) return;
  const channel = await client.channels.fetch(meta.channelId).catch(() => null);
  if (!channel) return;

  const participantsMap = contestParticipants.get(messageId) || new Map();
  const participants = Array.from(participantsMap.entries());

  const winnersCount = Math.min(meta.winnersCount || 1, participants.length);
  const winners = pickRandom(participants, winnersCount);

  // logi-konkurs
  const logiKonkursChannelId = "1451666381937578004";
  let logChannel = null;
  try {
    logChannel = await channel.guild.channels
      .fetch(logiKonkursChannelId)
      .catch(() => null);
  } catch (e) {
    logChannel = null;
  }

  let winnersDetails = "";
  if (winners.length > 0) {
    winnersDetails = winners
      .map(
        ([userId, nick], i) =>
          `\`${i + 1}.\` <@${userId}> (MC: ${nick || "brak"})`,
      )
      .join("\n");
  } else {
    winnersDetails = "Brak zwycięzców";
  }

  const podsumowanieEmbed = new EmbedBuilder()
    .setColor(COLOR_BLUE)
    .setDescription(
       "```\n" +
      "🎉 Konkurs zakończony 🎉\n" +
       "```\n" +
      `**🎁 • Nagroda:** ${meta.prize}\n\n` +
      `**🏆 • Zwycięzcy:**\n${winnersDetails}`,
    )
    .setTimestamp();

  if (logChannel) {
    try {
      await logChannel.send({ embeds: [podsumowanieEmbed] });
    } catch (e) {
      console.warn("Nie udało się wysłać do logi-konkurs:", e);
    }
  }

  // Edytuj wiadomość konkursową — EMBED z wynikami + przycisk podsumowujący
  try {
    const origMsg = await channel.messages.fetch(messageId).catch(() => null);
    if (origMsg) {
      // embed końcowy
      const publicWinners =
        winners.length > 0
          ? winners.map(([userId]) => `<@${userId}>`).join("\n")
          : "Brak zwycięzców";

      const finalEmbed = new EmbedBuilder()
        .setColor(COLOR_BLUE)
        .setDescription(
           "```\n" +
          "🎉 Konkurs zakończony 🎉\n" +
           "```\n" +
          `**🎁 • Nagroda:** ${meta.prize}\n\n` +
          `**🏆 • Zwycięzcy:**\n${publicWinners}`,
        )
        .setTimestamp();

      // Dodaj GIF przy zakończeniu konkursu
      try {
        const gifPath = path.join(
          __dirname,
          "attached_assets",
          "standard (3).gif",
        );
        const attachment = new AttachmentBuilder(gifPath, { name: "konkurs_end.gif" });
        finalEmbed.setImage("attachment://konkurs_end.gif");
      } catch (err) {
        console.warn("Nie udało się załadować GIFa przy zakończeniu konkursu:", err);
      }

      const personForm = getPersonForm(participants.length);
      let buttonLabel;
      if (participants.length === 1) {
        buttonLabel = `Wzięła udział 1 osoba`;
      } else if (
        participants.length % 10 >= 2 &&
        participants.length % 10 <= 4 &&
        (participants.length % 100 < 10 || participants.length % 100 >= 20)
      ) {
        buttonLabel = `Wzięły udział ${participants.length} ${personForm}`;
      } else {
        buttonLabel = `Wzięło udział ${participants.length} ${personForm}`;
      }

      const joinButton = new ButtonBuilder()
        .setCustomId(`konkurs_join_${messageId}`)
        .setLabel(buttonLabel)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true);

      const row = new ActionRowBuilder().addComponents(joinButton);

      // Dodaj GIF na zakończenie konkursu
      try {
        const gifPath = path.join(
          __dirname,
          "attached_assets",
          "standard (3).gif",
        );
        const attachment = new AttachmentBuilder(gifPath, { name: "konkurs_start.gif" });
        finalEmbed.setImage("attachment://konkurs_start.gif");
        await origMsg
          .edit({ embeds: [finalEmbed], components: [row], files: [attachment] })
          .catch(() => null);
      } catch (err) {
        console.warn("Nie udało się załadować GIFa na zakończenie konkursu:", err);
        try {
          finalEmbed.setImage(null);
        } catch (e) {
          // ignore
        }
        await origMsg
          .edit({ embeds: [finalEmbed], components: [row] })
          .catch(() => null);
      }
    }
  } catch (err) {
    console.warn("Nie udało się zedytować wiadomości konkursu na końcu:", err);
  }

  contests.delete(messageId);
  contestParticipants.delete(messageId);
  scheduleSavePersistentState();
}

// --- Obsługa opuszczenia konkursu ---
async function handleKonkursLeave(interaction, msgId) {
  const contest = contests.get(msgId);
  if (!contest) {
    await interaction.update({
      content: "❌ Konkurs nie został znaleziony.",
      components: [],
    });
    return;
  }

  let participantsMap = contestParticipants.get(msgId);
  if (!participantsMap) {
    await interaction.update({
      content: "❌ Nie bierzesz udziału w tym konkursie.",
      components: [],
    });
    return;
  }

  const userId = interaction.user.id;
  if (!participantsMap.has(userId)) {
    await interaction.update({
      content: "❌ Nie bierzesz udziału w tym konkursie.",
      components: [],
    });
    return;
  }

  // Usuwamy użytkownika z konkursu
  participantsMap.delete(userId);
  scheduleSavePersistentState();

  const participantsCount = participantsMap.size;

  // Aktualizujemy embed konkursu
  try {
    const ch = await client.channels.fetch(contest.channelId).catch(() => null);
    if (ch) {
      const origMsg = await ch.messages.fetch(msgId).catch(() => null);
      if (origMsg) {
        let updatedDescription =
          `🏆Liczba zwycięzców: ${contest.winnersCount}\n` +
          `Czas do końca konkursu: ${formatTimeDelta(contest.endsAt - Date.now())}\n` +
          `Nagroda: ${contest.prize}`;

        if (contest.invitesRequired > 0) {
          const inviteForm = getPersonForm(contest.invitesRequired);
          updatedDescription += `\n\n⚠️ Wymagane: dodać ${contest.invitesRequired} ${inviteForm} na serwer`;
        }

        const embed = origMsg.embeds[0]?.toJSON() || {};
        embed.description = updatedDescription;

        const joinButton = new ButtonBuilder()
          .setCustomId(`konkurs_join_${msgId}`)
          .setLabel(`Weź udział (${participantsCount})`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(false);
        const row = new ActionRowBuilder().addComponents(joinButton);

        await origMsg
          .edit({ embeds: [embed], components: [row] })
          .catch(() => null);
      }
    }
  } catch (e) {
    console.warn("Nie udało się zaktualizować embed/btn konkursu:", e);
  }

  await interaction.update({
    content: `✅ Opuściłeś konkurs.`,
    components: [],
  });
}

// --- Obsługa anulowania opuszczenia konkursu ---
async function handleKonkursCancelLeave(interaction, msgId) {
  await interaction.update({
    content: "❌ Anulowano. Nadal bierzesz udział w konkursie.",
    components: [],
  });
}

// Modified: prefer fixed log channel ID 1450800337932783768 if accessible; otherwise fallback to channel name heuristics
async function getLogiTicketChannel(guild) {
  if (!guild) return null;
  // try the requested specific channel ID first (user requested)
  const forcedId = "1450800337932783768";
  try {
    const forced = await guild.channels.fetch(forcedId).catch(() => null);
    if (forced && forced.type === ChannelType.GuildText) return forced;
  } catch (e) {
    // ignore
  }

  // First try exact name 'logi-ticket', then contains or similar
  const ch =
    guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        (c.name === "logi-ticket" ||
          c.name.toLowerCase().includes("logi-ticket") ||
          c.name.toLowerCase().includes("logi ticket") ||
          c.name.toLowerCase().includes("logi_ticket")),
    ) || null;
  return ch;
}

async function logTicketCreation(guild, ticketChannel, details) {
  try {
    const logCh = await getLogiTicketChannel(guild);
    if (!logCh) return;

    const embed = new EmbedBuilder()
      .setTitle("🎟️ Ticket utworzony")
      .setColor(COLOR_BLUE)
      .setDescription(
        `> \`🆔\` × Kanał: <#${ticketChannel.id}>\n` +
        `> \`👤\` × Właściciel: <@${details.openerId}> (\`${details.openerId}\`)\n` +
        `> \`📌\` × Typ ticketu: ${details.ticketTypeLabel}\n` +
        `> \`📄\` × Informacje:\n${details.formInfo}`,
      )
      .setTimestamp();

    await logCh.send({ embeds: [embed] });
  } catch (e) {
    console.error("logTicketCreation error:", e);
  }
}

async function archiveTicketOnClose(ticketChannel, closedById, ticketMeta) {
  try {
    const guild = ticketChannel.guild;
    const logCh = await getLogiTicketChannel(guild);
    if (!logCh) {
      console.warn("Brak kanału logi-ticket — pomijam logowanie ticketu.");
      return;
    }

    // Fetch all messages (up to 100)
    const fetched = await ticketChannel.messages
      .fetch({ limit: 100 })
      .catch(() => null);
    const messages = fetched ? Array.from(fetched.values()) : [];

    let beforeId = fetched && fetched.size ? fetched.last().id : null;
    while (beforeId) {
      const batch = await ticketChannel.messages
        .fetch({ limit: 100, before: beforeId })
        .catch(() => null);
      if (!batch || batch.size === 0) break;
      messages.push(...Array.from(batch.values()));
      beforeId = batch.size ? batch.last().id : null;
      if (batch.size < 100) break;
    }

    messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const openerId = ticketMeta?.userId || null;
    const claimedById = ticketMeta?.claimedBy || null;

    const participantsSet = new Set();
    for (const m of messages) {
      if (m && m.author && m.author.id) participantsSet.add(m.author.id);
    }
    const participants = Array.from(participantsSet);
    const participantsPreview = participants.slice(0, 20);
    const participantsText = participantsPreview.length
      ? `${participantsPreview.map((id) => `<@${id}>`).join(" ")}${participants.length > participantsPreview.length ? ` (+${participants.length - participantsPreview.length})` : ""}`
      : "brak";

    const embed = new EmbedBuilder()
      .setTitle("🎟️ Ticket zamknięty")
      .setColor(COLOR_BLUE)
      .setDescription(
        `> \`🆔\` × Kanał: **${ticketChannel.name}** (\`${ticketChannel.id}\`)\n` +
          `> \`👤\` × Właściciel: ${openerId ? `<@${openerId}> (\`${openerId}\`)` : "unknown"}\n` +
          `> \`🧑‍💼\` × Przejęty przez: ${claimedById ? `<@${claimedById}> (\`${claimedById}\`)` : "brak"}\n` +
          `> \`🔒\` × Zamknął: <@${closedById}> (\`${closedById}\`)\n` +
          `> \`💬\` × Wiadomości: **${messages.length}**\n` +
          `> \`👥\` × Uczestnicy: ${participantsText}`,
      )
      .setTimestamp();

    // Build transcript
    const lines = messages.map((m) => {
      const time = new Date(m.createdTimestamp).toLocaleString("pl-PL");
      const authorTag = m.author ? m.author.tag : "unknown";
      const authorId = m.author ? m.author.id : "unknown";
      const content = m.content ? m.content : "";
      const attachmentUrls =
        m.attachments && m.attachments.size
          ? Array.from(m.attachments.values())
            .map((a) => a.url)
            .join(", ")
          : "";
      const attachments = attachmentUrls ? `\n[ATTACHMENTS: ${attachmentUrls}]` : "";
      return `${time}\n${authorTag} (${authorId})\n${content}${attachments}`;
    });

    let transcriptText =
      `Ticket: ${ticketChannel.name}\n` +
      `Channel ID: ${ticketChannel.id}\n` +
      `Closed by: ${closedById}\n` +
      `Opened by: ${openerId || "unknown"}\n` +
      `Claimed by: ${claimedById || "brak"}\n` +
      `Messages: ${messages.length}\n` +
      `Participants: ${participants.join(", ") || "brak"}\n\n` +
      `--- MESSAGES ---\n\n` +
      lines.join("\n\n");

    const maxBytes = 7_500_000;
    let buffer = Buffer.from(transcriptText, "utf-8");
    if (buffer.length > maxBytes) {
      const ratio = maxBytes / buffer.length;
      const cutIndex = Math.max(0, Math.floor(transcriptText.length * ratio) - 50);
      transcriptText = `${transcriptText.slice(0, cutIndex)}\n\n[TRUNCATED]`;
      buffer = Buffer.from(transcriptText, "utf-8");
    }

    const fileName = `ticket-${ticketChannel.name.replace(/[^a-z0-9-_]/gi, "_")}-${Date.now()}.txt`;
    const attachment = new AttachmentBuilder(buffer, { name: fileName });

    await logCh.send({ embeds: [embed], files: [attachment] });
  } catch (e) {
    console.error("archiveTicketOnClose error:", e);
  }
}

// ---------------------------------------------------
// SYSTEM ROZLICZEN TYGODNIOWYCH
const ROZLICZENIA_CHANNEL_ID = "1449162620807675935";
const ROZLICZENIA_LOGS_CHANNEL_ID = "1457140136461730075";
const ROZLICZENIA_PROWIZJA = 0.10; // 10%

// Mapa na sumy sprzedaży w tygodniu
const weeklySales = new Map(); // userId -> { amount, lastUpdate }

// Funkcja do wysyłania wiadomości o rozliczeniach
async function sendRozliczeniaMessage() {
  try {
    const channel = await client.channels.fetch(ROZLICZENIA_CHANNEL_ID);
    if (!channel) return;

    // Sprawdź czy istnieje wiadomość informacyjna bota do usunięcia
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessage = messages.find(msg =>
      msg.author.id === client.user.id &&
      msg.embeds.length > 0 &&
      msg.embeds[0].title?.includes("ROZLICZENIA TYGODNIOWE")
    );

    // Jeśli wiadomość istnieje, usuń ją
    if (botMessage) {
      await botMessage.delete();
      console.log("Usunięto istniejącą wiadomość informacyjną ROZLICZENIA TYGODNIOWE");
    }

    // Wyślij nową wiadomość
    const embed = new EmbedBuilder()
      .setColor(0xd4af37)
      .setTitle("\`💱\` ROZLICZENIA TYGODNIOWE")
      .setDescription(
        "> \`ℹ️\` **Jeżeli sprzedajecie coś na shopie, wysyłacie tutaj kwotę, za którą dokonaliście sprzedaży. Na koniec każdego tygodnia w niedzielę rano macie czas do godziny 20:00, aby rozliczyć się i zapłacić 10% od łącznej sumy sprzedaży z __całego tygodnia.__**"
      )
      .setFooter({ text: "Użyj komendy /rozliczenie aby dodać sprzedaż" })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
    console.log("Wysłano wiadomość informacyjną ROZLICZENIA TYGODNIOWE");
  } catch (err) {
    console.error("Błąd wysyłania wiadomości ROZLICZENIA TYGODNIOWE:", err);
  }
}

// Funkcja do sprawdzania i resetowania cotygodniowych rozliczeń
async function checkWeeklyReset() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = niedziela
  const hour = now.getHours();

  // Reset w niedzielę o 20:01
  if (dayOfWeek === 0 && hour === 20 && now.getMinutes() === 1) {
    try {
      const logsChannel = await client.channels.fetch(ROZLICZENIA_LOGS_CHANNEL_ID);
      if (logsChannel && weeklySales.size > 0) {
        let totalSales = 0;
        let report = "📊 **RAPORT TYGODNIOWY**\n\n";

        for (const [userId, data] of weeklySales) {
          const prowizja = data.amount * ROZLICZENIA_PROWIZJA;
          report += `> 👤 <@${userId}>: Sprzedał: ${data.amount.toLocaleString("pl-PL")} zł | Do zapałaty: ${prowizja.toLocaleString("pl-PL")} zł\n`;
          totalSales += data.amount;
        }

        const totalProwizja = totalSales * ROZLICZENIA_PROWIZJA;
        report += `\n> 💰 **Łączna sprzedaż:** ${totalSales.toLocaleString("pl-PL")} zł\n`;
        report += `> 💸 **Łączna prowizja (10%):** ${totalProwizja.toLocaleString("pl-PL")} zł\n`;
        report += `> 📱 **Przelew na numer:** 880 260 392\n`;
        report += `> ⏳ **Termin płatności:** do 20:00 dnia dzisiejszego\n`;
        report += `> 🚫 **Brak płatności = brak dostępu do ticketów**`;

        await logsChannel.send(report);
      }

      // Reset mapy
      weeklySales.clear();
      console.log("Zresetowano cotygodniowe rozliczenia");
    } catch (err) {
      console.error("Błąd resetowania rozliczeń:", err);
    }
  }
}

// Listener dla nowych wiadomości na kanale rozliczeń
client.on('messageCreate', async (message) => {
  // Ignoruj wiadomości od botów
  if (message.author.bot) return;
  
  // Sprawdź czy wiadomość jest na kanale rozliczeń
  if (message.channelId === ROZLICZENIA_CHANNEL_ID) {
    // Jeśli to nie jest komenda rozliczenia, usuń wiadomość
    if (!message.content.startsWith('/rozliczenie')) {
      try {
        await message.delete();
        await message.author.send({
          embeds: [{
            color: 0xff0000,
            title: "❌ Ograniczenie kanału",
            description: `Na kanale <#${ROZLICZENIA_CHANNEL_ID}> można używać tylko komend rozliczeń!\n\n` +
                     `**Dostępne komendy:**\n` +
                     `• \`/rozliczenie [kwota]\` - dodaj sprzedaż`,
            footer: { text: "NewShop 5k$-1zł🏷️-×┃procenty-sell" }
          }]
        });
      } catch (err) {
        console.error("Błąd usuwania wiadomości z kanału rozliczeń:", err);
      }
      return;
    }
    
    // Odśwież wiadomość ROZLICZENIA TYGODNIOWE
    setTimeout(sendRozliczeniaMessage, 1000); // Małe opóźnienie dla pewności
  }
});

// Uruchom sprawdzanie co 5 minut
setInterval(checkWeeklyReset, 5 * 60 * 1000);

// Wysyłaj wiadomość o rozliczeniach co 12 godzin
setInterval(sendRozliczeniaMessage, 12 * 60 * 60 * 1000);

// Wyślij wiadomość przy starcie bota
setTimeout(sendRozliczeniaMessage, 5000);

// ---------------------------------------------------
// FULL MONITORING MODE - System statusów i alertów
// ---------------------------------------------------

const https = require('https');

let startTime = Date.now();
let lastPingCheck = Date.now();
let pingHistory = [];
let errorCount = 0;
let lastErrorTime = null;

// Funkcja formatowania uptime
function formatUptime(ms) {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hrs = Math.floor(min / 60);
  const days = Math.floor(hrs / 24);

  return `${days}d ${hrs % 24}h ${min % 60}m ${sec % 60}s`;
}

// Funkcja wysyłania embeda na webhook
async function sendMonitoringEmbed(title, description, color) {
  const webhookUrl = process.env.UPTIME_WEBHOOK;
  if (!webhookUrl) return;

  try {
    const payload = JSON.stringify({
      embeds: [{
        title: title,
        description: description,
        color: color,
        timestamp: new Date().toISOString(),
        footer: {
          text: "Bot Monitoring System",
          icon_url: client.user?.displayAvatarURL()
        }
      }]
    });

    const url = new URL(webhookUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => {});
    });

    req.on('error', (err) => {
      console.error("Błąd wysyłania monitoringu:", err);
    });

    req.write(payload);
    req.end();
  } catch (err) {
    console.error("Błąd wysyłania monitoringu:", err);
  }
}

// Funkcja sprawdzania statusu bota
function getBotStatus() {
  const ping = client.ws?.ping || 0;
  const uptime = Date.now() - startTime;
  
  let status = "🟢 Stabilny";
  let statusColor = 0x00ff00;
  
  if (ping > 400 || errorCount > 5) {
    status = "🔴 Krytyczny";
    statusColor = 0xff0000;
  } else if (ping > 200 || errorCount > 2) {
    status = "🟠 Ostrzeżenie";
    statusColor = 0xffaa00;
  }

  return { status, statusColor, ping, uptime };
}

// 1. Heartbeat co 5 minut (bot żyje + ping + uptime)
setInterval(async () => {
  const webhookUrl = process.env.UPTIME_WEBHOOK;
  if (!webhookUrl) return;

  const ping = client.ws?.ping || 0;
  const uptime = formatUptime(Date.now() - startTime);
  const { status, statusColor } = getBotStatus();

  // Zapisz ping do historii
  pingHistory.push(ping);
  if (pingHistory.length > 12) pingHistory.shift(); // 1 godzina historii

  const avgPing = Math.round(pingHistory.reduce((a, b) => a + b, 0) / pingHistory.length);

  const description = `⏱ **Uptime:** ${uptime}\n📡 **Ping:** ${ping}ms (średnio: ${avgPing}ms)\n🔢 **Błędy:** ${errorCount}\n📊 **Status:** ${status}`;

  await sendMonitoringEmbed("💓 Heartbeat - Bot działa", description, statusColor);
}, 5 * 60 * 1000); // co 5 minut

// 2. Alert przy błędzie krytycznym (bot padnie)
process.on("uncaughtException", async (err) => {
  console.error("🔴 Błąd krytyczny:", err);
  
  errorCount++;
  lastErrorTime = Date.now();

  const description = `**Błąd krytyczny detected:**\n\`${err.message}\`\n\n**Stack:**\n\`${err.stack?.substring(0, 1000) || "Brak stack trace"}...\`\n\n**Czas:** ${new Date().toLocaleString("pl-PL")}`;

  await sendMonitoringEmbed("🔴 BOT PADŁ - Błąd krytyczny", description, 0xff0000);

  // Daj chwilę na wysłanie alertu
  setTimeout(() => process.exit(1), 2000);
});

// 3. Alert przy zamknięciu procesu
process.on("exit", async () => {
  const uptime = formatUptime(Date.now() - startTime);
  const description = `Bot został zamknięty (process.exit)\n⏱ **Czas działania:** ${uptime}\n📊 **Liczba błędów:** ${errorCount}`;

  await sendMonitoringEmbed("🔴 Bot zamknięty", description, 0xff0000);
});

// 4. Monitor HTTP sprawdzający czy UptimeRobot pinguje
setInterval(async () => {
  const webhookUrl = process.env.UPTIME_WEBHOOK;
  if (!webhookUrl) return;

  try {
    const startTime = Date.now();
    
    const options = {
      hostname: 'bot-discord-hixl.onrender.com',
      path: '/',
      method: 'GET'
    };

    const req = https.request(options, (res) => {
      const responseTime = Date.now() - startTime;
      
      if (res.statusCode === 200) {
        const description = `🌐 **Monitor HTTP:** Aktywny\n📡 **Response time:** ${responseTime}ms\n📊 **Status:** HTTP ${res.statusCode}`;
        sendMonitoringEmbed("🟢 Monitor HTTP - OK", description, 0x00ff00);
      } else {
        const description = `🟠 **Monitor HTTP:** Nieoczekiwana odpowiedź\n📊 **Status:** HTTP ${res.statusCode}\n⏱ **Response time:** ${responseTime}ms`;
        sendMonitoringEmbed("🟠 Monitor HTTP - Ostrzeżenie", description, 0xffaa00);
      }
    });

    req.on('error', (err) => {
      const description = `🔴 **Monitor HTTP:** Brak odpowiedzi\n**Błąd:** ${err.message}\n**Czas:** ${new Date().toLocaleString("pl-PL")}`;
      sendMonitoringEmbed("🔴 Monitor HTTP - Błąd", description, 0xff0000);
    });

    req.setTimeout(10000, () => {
      req.destroy();
      const description = `🔴 **Monitor HTTP:** Timeout\n**Czas:** ${new Date().toLocaleString("pl-PL")}`;
      sendMonitoringEmbed("🔴 Monitor HTTP - Timeout", description, 0xff0000);
    });

    req.end();
  } catch (err) {
    const description = `🔴 **Monitor HTTP:** Błąd sprawdzania\n**Błąd:** ${err.message}\n**Czas:** ${new Date().toLocaleString("pl-PL")}`;
    sendMonitoringEmbed("🔴 Monitor HTTP - Błąd", description, 0xff0000);
  }
}, 10 * 60 * 1000); // co 10 minut

// 5. Raport okresowy co 12 godzin
setInterval(async () => {
  const webhookUrl = process.env.UPTIME_WEBHOOK;
  if (!webhookUrl) return;

  const { status, statusColor, ping, uptime } = getBotStatus();
  const uptimeFormatted = formatUptime(uptime);
  const avgPing = pingHistory.length > 0 ? Math.round(pingHistory.reduce((a, b) => a + b, 0) / pingHistory.length) : 0;

  const description = `📊 **RAPORT DZIAŁANIA BOTA**\n\n` +
    `⏱ **Uptime:** ${uptimeFormatted}\n` +
    `📡 **Ping aktualny:** ${ping}ms\n` +
    `📈 **Ping średni:** ${avgPing}ms\n` +
    `🌐 **Monitor HTTP:** Aktywny\n` +
    `🔢 **Liczba błędów:** ${errorCount}\n` +
    `📊 **Status:** ${status}\n` +
    `🕐 **Raport wygenerowany:** ${new Date().toLocaleString("pl-PL")}`;

  await sendMonitoringEmbed("📊 Raport okresowy - 12h", description, statusColor);
}, 12 * 60 * 60 * 1000); // co 12 godzin

// 6. Monitorowanie reconnectów Discord
client.on("reconnecting", () => {
  console.log("🔄 Bot próbuje się połączyć ponownie...");
  errorCount++;
});

client.on("resume", () => {
  const description = `🔄 **Bot wznowił połączenie**\n⏱ **Czas działania:** ${formatUptime(Date.now() - startTime)}\n📊 **Liczba błędów:** ${errorCount}`;
  sendMonitoringEmbed("🟢 Połączenie wznowione", description, 0x00ff00);
});

// 7. Funkcja ręcznego sprawdzania statusu
async function checkBotStatus() {
  const { status, statusColor, ping, uptime } = getBotStatus();
  const uptimeFormatted = formatUptime(uptime);
  const avgPing = pingHistory.length > 0 ? Math.round(pingHistory.reduce((a, b) => a + b, 0) / pingHistory.length) : 0;

  return {
    status,
    statusColor,
    ping,
    avgPing,
    uptime: uptimeFormatted,
    errorCount,
    lastErrorTime,
    guilds: client.guilds.cache.size,
    users: client.users.cache.size,
    channels: client.channels.cache.size
  };
}

// 8. Komenda statusu (opcjonalnie - można dodać do slash commands)
async function sendStatusReport(channel) {
  const status = await checkBotStatus();
  
  const embed = new EmbedBuilder()
    .setColor(status.statusColor)
    .setTitle("📊 Status Bota")
    .setDescription(`**Status:** ${status.status}`)
    .addFields(
      { name: "⏱ Uptime", value: status.uptime, inline: true },
      { name: "📡 Ping", value: `${status.ping}ms (avg: ${status.avgPing}ms)`, inline: true },
      { name: "🔢 Błędy", value: status.errorCount.toString(), inline: true },
      { name: "🌐 Serwery", value: status.guilds.toString(), inline: true },
      { name: "👥 Użytkownicy", value: status.users.toString(), inline: true },
      { name: "💬 Kanały", value: status.channels.toString(), inline: true }
    )
    .setTimestamp()
    .setFooter({ text: "Bot Monitoring System" });

  await channel.send({ embeds: [embed] });
}

console.log("🟢 FULL MONITORING MODE aktywowany - heartbeat co 5min, alerty błędów, monitor HTTP");

// ---------------------------------------------------

client
  .login(process.env.BOT_TOKEN)
  .catch((err) => console.error("Discord Login Error:", err));

const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot is alive'));
app.listen(3000);
