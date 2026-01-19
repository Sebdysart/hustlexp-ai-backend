import { createTRPCRouter } from "./create-context";
import hiRoute from "./routes/example/hi/route";

import { tasksListProcedure } from "./routes/tasks/list/route";
import { tasksGetProcedure } from "./routes/tasks/get/route";
import { tasksCreateProcedure } from "./routes/tasks/create/route";
import { tasksAcceptProcedure } from "./routes/tasks/accept/route";
import { tasksArrivedProcedure } from "./routes/tasks/arrived/route";
import { tasksCompleteProcedure } from "./routes/tasks/complete/route";
import { tasksListHistoryProcedure } from "./routes/tasks/listHistory/route";
import { tasksGetStateProcedure } from "./routes/tasks/getState/route";
import { tasksMessagesListProcedure } from "./routes/tasks/messages/list";
import { tasksMessagesSendProcedure } from "./routes/tasks/messages/send";
import { tasksMessagesGetConversationProcedure } from "./routes/tasks/messages/conversation";

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

import { capabilityGetProfileProcedure } from "./routes/capability/getProfile/route";

import { verificationSubmitLicenseProcedure } from "./routes/verification/submitLicense/route";
import { verificationSubmitInsuranceProcedure } from "./routes/verification/submitInsurance/route";
import { verificationInitiateBackgroundCheckProcedure } from "./routes/verification/initiateBackgroundCheck/route";
import { verificationResolveLicenseProcedure } from "./routes/verification/resolveLicense/route";
import { verificationResolveInsuranceProcedure } from "./routes/verification/resolveInsurance/route";
import { verificationResolveBackgroundCheckProcedure } from "./routes/verification/resolveBackgroundCheck/route";

export const appRouter = createTRPCRouter({
  example: createTRPCRouter({
    hi: hiRoute,
  }),
  
  tasks: createTRPCRouter({
    list: tasksListProcedure,
    listHistory: tasksListHistoryProcedure,
    getState: tasksGetStateProcedure,
    get: tasksGetProcedure,
    create: tasksCreateProcedure,
    accept: tasksAcceptProcedure,
    arrived: tasksArrivedProcedure,
    complete: tasksCompleteProcedure,
    messages: createTRPCRouter({
      list: tasksMessagesListProcedure,
      send: tasksMessagesSendProcedure,
      getConversation: tasksMessagesGetConversationProcedure,
    }),
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
  
  capability: createTRPCRouter({
    getProfile: capabilityGetProfileProcedure,
  }),

  verification: createTRPCRouter({
    submitLicense: verificationSubmitLicenseProcedure,
    submitInsurance: verificationSubmitInsuranceProcedure,
    initiateBackgroundCheck: verificationInitiateBackgroundCheckProcedure,
    resolveLicense: verificationResolveLicenseProcedure,
    resolveInsurance: verificationResolveInsuranceProcedure,
    resolveBackgroundCheck: verificationResolveBackgroundCheckProcedure,
  }),
});

export type AppRouter = typeof appRouter;
