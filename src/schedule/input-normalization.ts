const trimmedOrNull = (value: null | string | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const requiredText = (value: string, errorMessage: string): string => {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(errorMessage);
  }
  return trimmed;
};

export { requiredText, trimmedOrNull };
