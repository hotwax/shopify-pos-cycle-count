export const COUNT_TYPES = ['DYNAMIC_COUNT', 'DIRECTED_COUNT', 'HARD_COUNT'];
export const countTypeName = (type: string) => ({
  DYNAMIC_COUNT: 'Dynamic count',
  DIRECTED_COUNT: 'Directed count',
  HARD_COUNT: 'Hard count',
}[type] || type);

/** Where in the store a session counts. One list for creating, editing and validating sessions. */
export const AREAS = [
  {id: 'back_stock', name: 'Back stock'}, {id: 'display', name: 'Display'},
  {id: 'floor_wall', name: 'Floor wall'}, {id: 'floor_shelf', name: 'Floor shelf'},
  {id: 'overflow', name: 'Overflow'}, {id: 'register', name: 'Register'},
];
