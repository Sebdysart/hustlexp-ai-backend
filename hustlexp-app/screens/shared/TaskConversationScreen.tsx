/**
 * Task Conversation Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: TASK_CONVERSATION
 * Spec Authority: Phase V1.2 — Minimal Task-Scoped Messaging (LOCKED)
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. TASK-SCOPED: One conversation per task
 * 
 * 2. PARTICIPANTS: Only poster and assigned hustler can access
 * 
 * 3. PLAIN TEXT: No attachments, reactions, read receipts
 * 
 * 4. STATE GATED: Task must be ACCEPTED or WORKING (conversation open)
 * 
 * 5. AUTO-SCROLL: Auto-scroll to bottom on new message
 * 
 * ============================================================================
 * COMPONENT DEPENDENCIES
 * ============================================================================
 * 
 * Required Components:
 * - GlassCard (hustlexp-app/ui/GlassCard.tsx)
 * - PrimaryActionButton (hustlexp-app/ui/PrimaryActionButton.tsx)
 * 
 * Required Tokens:
 * - colors (hustlexp-app/ui/colors.ts)
 * - spacing (hustlexp-app/ui/spacing.ts)
 * - typography (hustlexp-app/ui/typography.ts)
 * 
 * ============================================================================
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';

interface TaskConversationScreenProps {
  route: {
    params: {
      taskId: string;
    };
  };
  navigation: any;
}

interface Message {
  id: string;
  conversationId: string;
  senderRole: 'POSTER' | 'HUSTLER' | 'SYSTEM';
  senderId: string | null;
  body: string;
  createdAt: Date;
}

/**
 * Task Conversation Screen
 * 
 * Displays messages for a task conversation.
 * Allows poster and assigned hustler to send/receive messages.
 * 
 * Phase V1.2: Minimal implementation (plain text only, no attachments).
 */
export default function TaskConversationScreen({ route, navigation }: TaskConversationScreenProps) {
  const { taskId } = route.params;
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageBody, setMessageBody] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const scrollViewRef = useRef<ScrollView>(null);

  // TODO: Phase N2 — Replace mock data with real tRPC queries
  // For V1.2, we'll use mock data to validate the screen structure
  useEffect(() => {
    // Mock: Load messages
    // In real implementation: trpc.tasks.messages.list.useQuery({ taskId })
    setTimeout(() => {
      setMessages([
        {
          id: '1',
          conversationId: 'conv-1',
          senderRole: 'SYSTEM',
          senderId: null,
          body: 'Conversation started. You can now message each other.',
          createdAt: new Date(Date.now() - 3600000), // 1 hour ago
        },
      ]);
      setIsLoading(false);
    }, 500);
  }, [taskId]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollViewRef.current && messages.length > 0) {
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages]);

  const handleSend = async () => {
    if (!messageBody.trim() || isSending) return;

    const trimmedBody = messageBody.trim();
    setMessageBody('');
    setIsSending(true);

    // TODO: Phase N2 — Replace with real tRPC mutation
    // In real implementation: trpc.tasks.messages.send.useMutation()
    // For V1.2, we'll simulate sending
    const newMessage: Message = {
      id: `msg-${Date.now()}`,
      conversationId: 'conv-1',
      senderRole: 'HUSTLER', // TODO: Get from current user context
      senderId: 'user-1',
      body: trimmedBody,
      createdAt: new Date(),
    };

    setMessages((prev) => [...prev, newMessage]);
    setIsSending(false);

    // TODO: Call tRPC mutation
    // await trpc.tasks.messages.send.mutate({ taskId, body: trimmedBody });
  };

  const formatTime = (date: Date) => {
    return new Date(date).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const isOwnMessage = (message: Message) => {
    // TODO: Compare with current user ID
    // For V1.2, assume hustler role for demo
    return message.senderRole === 'HUSTLER';
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <MaterialIcons
          name="arrow-back"
          size={24}
          color={colors.textPrimary}
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        />
        <Text style={styles.headerTitle}>Task Messages</Text>
        <View style={styles.backButton} />
      </View>

      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <ScrollView
          ref={scrollViewRef}
          style={styles.messagesContainer}
          contentContainerStyle={styles.messagesContent}
          onContentSizeChange={() => {
            scrollViewRef.current?.scrollToEnd({ animated: true });
          }}
        >
          {isLoading ? (
            <View style={styles.loadingContainer}>
              <Text style={styles.loadingText}>Loading messages...</Text>
            </View>
          ) : messages.length === 0 ? (
            <View style={styles.emptyContainer}>
              <MaterialIcons name="chat-bubble-outline" size={48} color={colors.textSecondary} />
              <Text style={styles.emptyText}>No messages yet</Text>
              <Text style={styles.emptySubtext}>Start the conversation</Text>
            </View>
          ) : (
            messages.map((message) => (
              <View
                key={message.id}
                style={[
                  styles.messageWrapper,
                  isOwnMessage(message) ? styles.ownMessageWrapper : styles.otherMessageWrapper,
                ]}
              >
                {message.senderRole === 'SYSTEM' ? (
                  <View style={styles.systemMessage}>
                    <Text style={styles.systemMessageText}>{message.body}</Text>
                  </View>
                ) : (
                  <View
                    style={[
                      styles.messageBubble,
                      isOwnMessage(message) ? styles.ownMessageBubble : styles.otherMessageBubble,
                    ]}
                  >
                    <Text
                      style={[
                        styles.messageText,
                        isOwnMessage(message) ? styles.ownMessageText : styles.otherMessageText,
                      ]}
                    >
                      {message.body}
                    </Text>
                    <Text
                      style={[
                        styles.messageTime,
                        isOwnMessage(message) ? styles.ownMessageTime : styles.otherMessageTime,
                      ]}
                    >
                      {formatTime(message.createdAt)}
                    </Text>
                  </View>
                )}
              </View>
            ))
          )}
        </ScrollView>

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.textInput}
            placeholder="Type a message..."
            placeholderTextColor={colors.textSecondary}
            value={messageBody}
            onChangeText={setMessageBody}
            multiline
            maxLength={5000}
            editable={!isSending}
          />
          <TouchableOpacity
            onPress={handleSend}
            disabled={!messageBody.trim() || isSending}
            style={[styles.sendButton, (!messageBody.trim() || isSending) && styles.sendButtonDisabled]}
          >
            <MaterialIcons
              name="send"
              size={20}
              color={colors.textPrimary}
            />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.card,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorderSecondary,
  },
  backButton: {
    width: 40,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  keyboardView: {
    flex: 1,
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    padding: spacing.card,
    paddingBottom: spacing.section,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: spacing.section,
  },
  loadingText: {
    fontSize: 16,
    color: colors.textSecondary,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: spacing.section,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textPrimary,
    marginTop: spacing.card,
  },
  emptySubtext: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 4,
  },
  messageWrapper: {
    marginBottom: 8,
  },
  ownMessageWrapper: {
    alignItems: 'flex-end',
  },
  otherMessageWrapper: {
    alignItems: 'flex-start',
  },
  systemMessage: {
    alignSelf: 'center',
    backgroundColor: colors.glassSecondary,
    paddingHorizontal: spacing.card,
    paddingVertical: 4,
    borderRadius: 12,
    maxWidth: '80%',
  },
  systemMessageText: {
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  messageBubble: {
    maxWidth: '75%',
    paddingHorizontal: spacing.card,
    paddingVertical: 8,
    borderRadius: 16,
  },
  ownMessageBubble: {
    backgroundColor: colors.primaryAction,
    borderBottomRightRadius: 4,
  },
  otherMessageBubble: {
    backgroundColor: colors.glassSecondary,
    borderBottomLeftRadius: 4,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 22,
  },
  ownMessageText: {
    color: colors.textPrimary,
  },
  otherMessageText: {
    color: colors.textPrimary,
  },
  messageTime: {
    fontSize: 11,
    marginTop: 4,
  },
  ownMessageTime: {
    color: colors.textPrimary,
    opacity: 0.8,
  },
  otherMessageTime: {
    color: colors.textSecondary,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: spacing.card,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorderSecondary,
    backgroundColor: colors.background,
  },
  textInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    paddingHorizontal: spacing.card,
    paddingVertical: 8,
    backgroundColor: colors.glassSecondary,
    borderRadius: 20,
    fontSize: 16,
    color: colors.textPrimary,
    marginRight: 8,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primaryAction,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
});
