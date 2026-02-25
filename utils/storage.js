function getLocal(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => resolve(data));
  });
}

function setLocal(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, () => resolve());
  });
}

async function appendRecord(record) {
  const data = await getLocal({ applicationRecords: [] });
  const next = [...(data.applicationRecords || []), record];
  await setLocal({ applicationRecords: next });
  return next;
}

window.GetEmployedStorage = {
  getLocal,
  setLocal,
  appendRecord,
};
