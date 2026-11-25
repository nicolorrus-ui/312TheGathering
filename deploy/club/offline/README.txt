Hexproof Club 离线调试版

启动
先将整个压缩包解压到可写目录。Windows 建议使用短路径，例如 C:\Club。
Windows x64 双击 Start-Club.cmd。Linux x64 在解压目录运行 ./start-club.sh。
包内已附 Java 21、Forge、网页、卡牌及印次目录。启动后保持终端窗口打开。
等待默认浏览器打开 http://127.0.0.1:57325/ 。也可以手动输入此地址。
按 Ctrl+C 停止服务。网络可以全程断开。

试一局
1. 输入牌手名字，进入 Deck builder。打开 Import decklist，把随包
   offline-demo.txt 的全文粘贴进去，输入套牌名并选择 Save deck。
2. 回到 Duels，将 Opponent 设为 Practice opponent、Format 设为 Modern，
   创建练习房。选择刚保存的套牌，点击 Use deck，再点 Ready。
3. 如需操作双方，使用两个独立的浏览器配置文件，各自进入俱乐部、导入牌表。
   用第一个配置文件创建双人房，第二个用房间码和密码加入。
   测试直播时建房勾选 Live mode，在本机打开观战链接。

调试
在浏览器中打开开发者工具可以查看 TypeScript 源码、网络请求和 WebSocket 帧。
终端和 state/club-debug.log 记录启动和对局诊断。Forge 崩溃报告如有生成，
位于 state/retained/forge-crashes/。BUILD.txt 记录源码提交。
浏览器按配置文件和本地地址保存套牌。保持端口不变可在下次打开原牌库。
端口占用时可在启动前设置环境变量 CLUB_PORT。设置 CLUB_NO_BROWSER=1
会保留终端服务，可手动打开地址。CLUB_STATE_DIR 可指定服务端数据目录。

卡牌与图片
搜索和换版使用随包 Forge 数据。本地图包已有对应插画时显示插画，
其余牌显示离线文字卡面。自有兼容图包可复制到 web/assets/cards/，
保留 index.json 和其中引用的 JPG，然后重启服务、刷新页面。
