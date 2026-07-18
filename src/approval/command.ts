type ApprovalCommandText = '/no' | '/yes';

const parseApprovalCommand = (text: string): ApprovalCommandText | null => {
  const normalized = text.trim().toLowerCase();
  return normalized === '/yes' || normalized === '/no' ? normalized : null;
};

export { parseApprovalCommand };
export type { ApprovalCommandText };
