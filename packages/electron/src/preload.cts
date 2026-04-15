const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('__DISPATCH_CORE_URL__', 'http://localhost:7890')
