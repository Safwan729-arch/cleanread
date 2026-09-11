/** Message types passed between popup, background and content scripts. */
export const MSG = {
  CLEAN_PAGE: 'cleanread/clean-page',
  RESTORE_PAGE: 'cleanread/restore-page',
  GET_STATE: 'cleanread/get-state',
  GET_ARTICLE: 'cleanread/get-article',
  APPLY_SETTINGS: 'cleanread/apply-settings',
  PRINT_PAGE: 'cleanread/print-page',

  // content script -> background (IndexedDB must live in the extension origin)
  GET_HIGHLIGHTS: 'cleanread/get-highlights',
  SET_HIGHLIGHTS: 'cleanread/set-highlights',
}
