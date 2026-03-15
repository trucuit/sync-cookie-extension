// Background service worker for Sync Cookie Extension

chrome.runtime.onInstalled.addListener(() => {
  console.log('Sync Cookie Extension installed');
});

// Handle messages from popup or content scripts
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  console.log('Message received:', request);
  sendResponse({ success: true });
  return true;
});

export {};
