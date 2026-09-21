// Mock socket.io — tests don't need real WebSocket connections
export const getIO = jest.fn().mockReturnValue({
  to: jest.fn().mockReturnThis(),
  emit: jest.fn(),
});
