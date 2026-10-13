// Copy this file to config.h (same folder) and fill in the four values.
// config.h is kept out of git because it holds this unit's secret token.

// WiFi network to join. Must be 2.4 GHz. Leave the password empty for an
// open network like Rice Visitor.
const char* WIFI_NAME     = "Rice Visitor";
const char* WIFI_PASSWORD = "";

// Address of the Rec Tracker website, with https:// and no slash at the end.
const char* SERVER_URL = "https://your-site.vercel.app";

// This unit's token. Get it from the website's admin page: Add a sensor.
// Each unit needs its own.
const char* DEVICE_TOKEN = "rt_paste_token_here";
