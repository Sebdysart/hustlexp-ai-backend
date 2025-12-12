import { createTRPCRouter } from "./create-context";
import hiRoute from "./routes/example/hi/route";

import { tasksListProcedure } from "./routes/tasks/list/route";
import { tasksGetProcedure } from "./routes/tasks/get/route";
import { tasksCreateProcedure } from "./routes/tasks/create/route";
import { tasksAcceptProcedure } from "./routes/tasks/accept/route";
import { tasksCompleteProcedure } from "./routes/tasks/complete/route";

import { usersMeProcedure, usersUpdateProcedure, usersOnboardProcedure } from "./routes/users/route";

import {
  xpAddXPProcedure,
  badgesAwardProcedure,
  questsListProcedure,
  questsClaimProcedure,
} from "./routes/gamification/route";

import {
  walletBalanceProcedure,
  walletTransactionsProcedure,
  boostsListProcedure,
  boostsActivateProcedure,
} from "./routes/wallet/route";

import {
  leaderboardWeeklyProcedure,
  leaderboardAllTimeProcedure,
} from "./routes/leaderboard/route";

import { chatListProcedure, chatSendProcedure } from "./routes/chat/route";

import {
  proactiveGetPreferencesProcedure,
  proactiveUpdatePreferencesProcedure,
  proactiveGetRecommendationsProcedure,
  proactiveScanProcedure,
  proactiveRegisterDeviceProcedure,
} from "./routes/proactive/route";

export const appRouter = createTRPCRouter({
  example: createTRPCRouter({
    hi: hiRoute,
  }),
  
  tasks: createTRPCRouter({
    list: tasksListProcedure,
    get: tasksGetProcedure,
    create: tasksCreateProcedure,
    accept: tasksAcceptProcedure,
    complete: tasksCompleteProcedure,
  }),
  
  users: createTRPCRouter({
    me: usersMeProcedure,
    update: usersUpdateProcedure,
    onboard: usersOnboardProcedure,
  }),
  
  xp: createTRPCRouter({
    addXP: xpAddXPProcedure,
  }),
  
  badges: createTRPCRouter({
    award: badgesAwardProcedure,
  }),
  
  quests: createTRPCRouter({
    list: questsListProcedure,
    claim: questsClaimProcedure,
  }),
  
  wallet: createTRPCRouter({
    balance: walletBalanceProcedure,
    transactions: walletTransactionsProcedure,
  }),
  
  boosts: createTRPCRouter({
    list: boostsListProcedure,
    activate: boostsActivateProcedure,
  }),
  
  leaderboard: createTRPCRouter({
    weekly: leaderboardWeeklyProcedure,
    allTime: leaderboardAllTimeProcedure,
  }),
  
  chat: createTRPCRouter({
    list: chatListProcedure,
    send: chatSendProcedure,
  }),
  
  proactive: createTRPCRouter({
    getPreferences: proactiveGetPreferencesProcedure,
    updatePreferences: proactiveUpdatePreferencesProcedure,
    getRecommendations: proactiveGetRecommendationsProcedure,
    scan: proactiveScanProcedure,
    registerDevice: proactiveRegisterDeviceProcedure,
  }),
});

export type AppRouter = typeof appRouter;
