// Settings shared by the content script and the popup.
// "__original__" = the video's original-language track, "__none__" = hide that line.
const DS_DEFAULTS = {
  enabled: true,
  primary: '__original__',
  secondary: (navigator.language || 'en').split('-')[0],
  order: 'primary-top',        // 'primary-top' | 'secondary-top'
  sizePrimary: 4.2,            // % of player height
  sizeSecondary: 3.4,
  colorPrimary: '#ffffff',
  colorSecondary: '#ffd54a',
  bg: 0.55,                    // background opacity
  bottom: 10                   // % from the bottom of the player
};
