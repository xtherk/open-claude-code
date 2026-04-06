# 脚本使用方式

## download-claude-binaries.cmd

简介：用于从GCS(google cloud storage) 中下载各平台claude二进制文件

- 只下载主二进制`download-claude-binaries.cmd 2.1.89`

- 连压缩包一起下`download-claude-binaries.cmd 2.1.89 -IncludeCompressed`

- 指定输出目录  `download-claude-binaries.cmd 2.1.89 -OutputDir D:\Temp\claude-dist`                                                                                                      

- 路径里有空格`download-claude-binaries.cmd 2.1.89 -OutputDir "D:\Temp\claude dist" -IncludeCompressed`

**输出目录示例：**

```txt
2.1.89
├── darwin-arm64
│   ├── claude
│   ├── claude.app.tar.zst
│   └── claude.zst
├── darwin-x64
│   ├── claude
│   ├── claude.app.tar.zst
│   └── claude.zst
├── linux-arm64
│   ├── claude
│   └── claude.zst
├── linux-arm64-musl
│   ├── claude
│   └── claude.zst
├── linux-x64
│   ├── claude
│   └── claude.zst
├── linux-x64-musl
│   ├── claude
│   └── claude.zst
├── win32-arm64
│   ├── claude.exe
│   └── claude.exe.zst
├── win32-x64
│   ├── claude.exe
│   └── claude.exe.zst
└── manifest.json
```

## extract-native-deps-from-claude.mjs

命令：`node scripts/extract-native-deps-from-claude.mjs {claude_dist_dir}` ， claude_dist_dir目录为上述输出目录格式路径。

作用：从claude二进制中提取node模块

> 示例：`node scripts/extract-native-deps-from-claude.mjs C:\Users\admin\Desktop\claude\2.1.89`

## stage-recovered-vendor-from-artifacts.mjs

命令：`node scripts/stage-recovered-vendor-from-artifacts.mjs`

作用：将`extract-native-deps-from-claude.mjs`提取出的模块转为项目使用的格式



> 示例：
>
> ```
> node ./scripts/stage-recovered-vendor-from-artifacts.mjs --report ./artifacts/claude-native-deps/report.json --out-dir ./artifacts/recovered-vendor-exact
> ```

## restore-sourcemap-sources.mjs

从sourcemap中提取源码等文件