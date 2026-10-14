/*
  A hook handler for the suites to register: it keeps what it was given so a test can count calls.
*/
export default data => {
  (globalThis.kempoPaymentsHooks ||= []).push(data);
};
