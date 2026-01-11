const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Weekly sales functions
async function saveWeeklySale(userId, amount, guildId = "default") {
  // Pobierz początek tygodnia (niedziela)
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = niedziela
  const diff = now.getDate() - dayOfWeek;
  const weekStart = new Date(now.setDate(diff));
  weekStart.setHours(0, 0, 0, 0);
  
  const { error } = await supabase
    .from("weekly_sales")
    .upsert({ 
      user_id: userId, 
      guild_id: guildId,
      amount, 
      week_start: weekStart.toISOString().split('T')[0] // YYYY-MM-DD
    });
  if (error) console.error("[Supabase] Błąd zapisu weekly_sales:", error);
  else console.log(`[Supabase] Zapisano weekly_sales: ${userId} -> ${amount}`);
}

async function getWeeklySales(guildId = null) {
  // Pobierz początek aktualnego tygodnia (niedziela)
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = niedziela
  const diff = now.getDate() - dayOfWeek;
  const weekStart = new Date(now.setDate(diff));
  weekStart.setHours(0, 0, 0, 0);
  const weekStartStr = weekStart.toISOString().split('T')[0]; // YYYY-MM-DD
  
  let query = supabase
    .from("weekly_sales")
    .select("*")
    .eq("week_start", weekStartStr); // Tylko aktualny tydzień
    
  if (guildId) {
    query = query.eq("guild_id", guildId); // Konkretny guild
  }
  
  const { data, error } = await query;
  if (error) {
    console.error("[Supabase] Błąd odczytu weekly_sales:", error);
    return [];
  }
  return data;
}

// Invite counts functions
async function saveInviteCount(guildId, userId, count) {
  const { error } = await supabase
    .from("invite_counts")
    .upsert({ 
      guild_id: guildId,
      user_id: userId,
      count,
      updated_at: new Date().toISOString()
    });
  if (error) console.error("[Supabase] Błąd zapisu invite_counts:", error);
  else console.log(`[Supabase] Zapisano invite_counts: ${guildId}/${userId} -> ${count}`);
}

async function getInviteCounts(guildId) {
  const { data, error } = await supabase
    .from("invite_counts")
    .select("*")
    .eq("guild_id", guildId);
  if (error) {
    console.error("[Supabase] Błąd odczytu invite_counts:", error);
    return [];
  }
  return data;
}

// Ticket functions
async function saveTicketOwner(channelId, ticketData) {
  const { error } = await supabase
    .from("ticket_owners")
    .upsert({ 
      channel_id: channelId,
      ...ticketData,
      updated_at: new Date().toISOString()
    });
  if (error) console.error("[Supabase] Błąd zapisu ticket_owners:", error);
  else console.log(`[Supabase] Zapisano ticket_owners: ${channelId}`);
}

async function getTicketOwners() {
  const { data, error } = await supabase.from("ticket_owners").select("*");
  if (error) {
    console.error("[Supabase] Błąd odczytu ticket_owners:", error);
    return [];
  }
  return data;
}

// Active codes functions
async function saveActiveCode(code, codeData) {
  const { error } = await supabase
    .from("active_codes")
    .upsert({ 
      code,
      ...codeData,
      updated_at: new Date().toISOString()
    });
  if (error) console.error("[Supabase] Błąd zapisu active_codes:", error);
  else console.log(`[Supabase] Zapisano active_codes: ${code}`);
}

async function getActiveCodes() {
  const { data, error } = await supabase.from("active_codes").select("*");
  if (error) {
    console.error("[Supabase] Błąd odczytu active_codes:", error);
    return [];
  }
  return data;
}

// Contest functions
async function saveContest(messageId, contestData) {
  const { error } = await supabase
    .from("contests")
    .upsert({ 
      message_id: messageId,
      ...contestData,
      updated_at: new Date().toISOString()
    });
  if (error) console.error("[Supabase] Błąd zapisu contests:", error);
  else console.log(`[Supabase] Zapisano contests: ${messageId}`);
}

async function getContests() {
  const { data, error } = await supabase.from("contests").select("*");
  if (error) {
    console.error("[Supabase] Błąd odczytu contests:", error);
    return [];
  }
  return data;
}

// Contest participants functions
async function saveContestParticipant(messageId, userId) {
  const { error } = await supabase
    .from("contest_participants")
    .upsert({ 
      message_id: messageId,
      user_id: userId,
      joined_at: new Date().toISOString()
    });
  if (error) console.error("[Supabase] Błąd zapisu contest_participants:", error);
  else console.log(`[Supabase] Zapisano contest_participants: ${messageId}/${userId}`);
}

async function getContestParticipants(messageId) {
  const { data, error } = await supabase
    .from("contest_participants")
    .select("*")
    .eq("message_id", messageId);
  if (error) {
    console.error("[Supabase] Błąd odczytu contest_participants:", error);
    return [];
  }
  return data;
}

// Active codes functions
async function saveActiveCode(code, codeData) {
  const { error } = await supabase
    .from("active_codes")
    .upsert({ 
      code,
      user_id: codeData.oderId || codeData.user_id,
      discount: codeData.discount || 0,
      expires_at: new Date(codeData.expiresAt).toISOString(),
      used: codeData.used || false,
      reward: codeData.reward,
      reward_amount: codeData.rewardAmount,
      reward_text: codeData.rewardText,
      type: codeData.type,
      updated_at: new Date().toISOString()
    });
  if (error) console.error("[Supabase] Błąd zapisu active_codes:", error);
  else console.log(`[Supabase] Zapisano active_code: ${code}`);
}

async function getActiveCodes() {
  const { data, error } = await supabase.from("active_codes").select("*");
  if (error) {
    console.error("[Supabase] Błąd odczytu active_codes:", error);
    return [];
  }
  return data;
}

async function updateActiveCode(code, updates) {
  const { error } = await supabase
    .from("active_codes")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("code", code);
  if (error) console.error("[Supabase] Błąd aktualizacji active_codes:", error);
  else console.log(`[Supabase] Zaktualizowano active_code: ${code}`);
}

module.exports = {
  saveWeeklySale,
  getWeeklySales,
  saveInviteCount,
  getInviteCounts,
  saveTicketOwner,
  getTicketOwners,
  saveActiveCode,
  getActiveCodes,
  updateActiveCode,
  saveContest,
  getContests,
  saveContestParticipant,
  getContestParticipants,
  supabase
};
