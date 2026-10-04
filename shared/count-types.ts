export const COUNT_TYPES = ['DYNAMIC_COUNT', 'DIRECTED_COUNT', 'HARD_COUNT'];
export const countTypeName = (type: string) => ({
  DYNAMIC_COUNT: 'Dynamic count',
  DIRECTED_COUNT: 'Directed count',
  HARD_COUNT: 'Hard count',
}[type] || type);
