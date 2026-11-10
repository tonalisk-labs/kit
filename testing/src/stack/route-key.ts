/** Whether a fake's route pattern, as `POST /fake/pay/*`, matches a call's method and path: each
 *  `*` stands for one segment. */
export const routeMatches = (pattern: string, key: string): boolean => {
  const [wanted, given] = [pattern.split('/'), key.split('/')];
  return (
    wanted.length === given.length &&
    wanted.every((segment, index) => segment === '*' || segment === given[index])
  );
};
