// Public browser configuration only.
// Never put PI_SERVER_API_KEY, Supabase service-role keys, or user access tokens here.
window.FOP_CONFIG = Object.freeze({
  ENVIRONMENT: "mainnet-pi-browser",
  PI_SANDBOX: false, // Real Pi Browser, including Testnet; not the payment network selector.
  CHECKOUT_URL: "https://fileorganizercore.ir/checkout.html",
  SUPABASE_URL: "https://rjxowzwuusqmfjjzzvgp.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_IwbLVVwSDzHczFH3PuVhtA_h-UJXC7q",
  // Set to the real HTTPS release URL after publishing FileOrganizerCore-Setup.exe.
  DOWNLOAD_URL: "https://github.com/aslani99/FileOrganizerCore-Mainnet/releases/download/v1.0.1-Mainnet/FileOrganizerCore-Mainnet-Setup.exe",
});
