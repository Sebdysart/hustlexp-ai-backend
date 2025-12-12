export const r2 = {
  generateTaskProofKey: (taskId: string, timestamp: number) => {
    return `tasks/${taskId}/proof_${timestamp}.jpg`;
  },
  uploadFile: async (key: string, data: Buffer) => {
    console.log('[R2 Stub] Upload file:', key);
    return { url: `https://stub.r2.dev/${key}` };
  },
};
