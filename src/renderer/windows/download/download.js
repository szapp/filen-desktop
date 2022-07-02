import React, { memo, useState, useEffect, useCallback, useRef } from "react"
import { Flex, Text, Input, InputGroup, InputRightElement, Button, Spinner, Progress, Link } from "@chakra-ui/react"
import useDarkMode from "../../lib/hooks/useDarkMode"
import useLang from "../../lib/hooks/useLang"
import usePlatform from "../../lib/hooks/usePlatform"
import Titlebar from "../../components/Titlebar"
import { i18n } from "../../lib/i18n"
import Container from "../../components/Container"
import IsOnlineBottomToast from "../../components/IsOnlineBottomToast"
import { Base64 } from "js-base64"
import colors from "../../styles/colors"
import ipc from "../../lib/ipc"
import * as fsLocal from "../../lib/fs/local"
import db from "../../lib/db"
import { apiRequest, downloadChunk } from "../../lib/api"
import { convertTimestampToMs, bpsToReadable, getTimeRemaining, Semaphore } from "../../lib/helpers"
import { v4 as uuidv4 } from "uuid"
import { maxDownloadThreads, maxConcurrentDownloads } from "../../lib/constants"
import eventListener from "../../lib/eventListener"
import { throttle } from "lodash"
import { AiOutlineCheckCircle } from "react-icons/ai"
import { showToast } from "../../components/Toast"
import { decryptData } from "../../lib/crypto"
import useDb from "../../lib/hooks/useDb"

const log = window.require("electron-log")
const pathModule = window.require("path")
const fs = window.require("fs-extra")
const { shell, ipcRenderer } = window.require("electron")

const FROM_ID = uuidv4()
const params = new URLSearchParams(window.location.search)
const passedArgs = typeof params.get("args") == "string" ? JSON.parse(Base64.decode(decodeURIComponent(params.get("args")))) : undefined
const downloadSemaphore = new Semaphore(maxConcurrentDownloads)
const downloadThreadsSemaphore = new Semaphore(maxDownloadThreads)

const downloadFile = (absolutePath, file) => {
    return new Promise((resolve, reject) => {
        try{
            var parentPath = pathModule.dirname(absolutePath)
        }
        catch(e){
            return reject(e)
        }

        Promise.all([
            fs.ensureDir(parentPath),
            fsLocal.getTempDir()
        ]).then(([_, tmpDir]) => {
            try{
                var fileTmpPath = fsLocal.normalizePath(tmpDir + "/" + uuidv4())
            }
            catch(e){
                return reject(e)
            }

            Promise.all([
                fsLocal.rm(absolutePath),
                fsLocal.rm(fileTmpPath)
            ]).then(async () => {
                try{
                    var stream = fs.createWriteStream(fileTmpPath)
                }
                catch(e){
                    return reject(e)
                }

                const fileChunks = file.chunks
                let currentWriteIndex = 0

                const downloadTask = (index) => {
                    return new Promise((resolve, reject) => {
                        downloadChunk({
                            region: file.region,
                            bucket: file.bucket,
                            uuid: file.uuid,
                            index,
                            from: FROM_ID
                        }).then((data) => {
                            decryptData(data, file.metadata.key, file.version).then((decrypted) => {
                                return resolve({
                                    index,
                                    data: Buffer.from(decrypted)
                                })
                            }).catch(reject)
                        }).catch(reject)
                    })
                }

                const writeChunk = (index, data) => {
                    if(index !== currentWriteIndex){
                        return setTimeout(() => {
                            writeChunk(index, data)
                        }, 10)
                    }

                    stream.write(data, (err) => {
                        if(err){
                            return reject(err)
                        }

                        console.log(file.uuid, index, "written")

                        currentWriteIndex += 1

                        return true
                    })
                }

                try{
                    await new Promise((resolve, reject) => {
                        let done = 0

                        for(let i = 0; i < fileChunks; i++){
                            downloadThreadsSemaphore.acquire().then(() => {
                                downloadTask(i).then(({ index, data }) => {
                                    writeChunk(index, data)

                                    done += 1

                                    downloadThreadsSemaphore.release()

                                    if(done >= fileChunks){
                                        return resolve(true)
                                    }
                                }).catch((err) => {
                                    downloadThreadsSemaphore.release()

                                    return reject(err)
                                })
                            })
                        }
                    })

                    await new Promise((resolve) => {
                        if(currentWriteIndex >= fileChunks){
                            return resolve(true)
                        }

                        const wait = setInterval(() => {
                            if(currentWriteIndex >= fileChunks){
                                clearInterval(wait)

                                return resolve(true)
                            }
                        }, 10)
                    })

                    await new Promise((resolve, reject) => {
                        stream.close((err) => {
                            if(err){
                                return reject(err)
                            }

                            return resolve(true)
                        })
                    })
                }
                catch(e){
                    fs.unlink(fileTmpPath)

                    return reject(e)
                }

                fsLocal.move(fileTmpPath, absolutePath).then(() => {
                    fs.utimes(absolutePath, new Date(convertTimestampToMs(file.metadata.lastModified)), new Date(convertTimestampToMs(file.metadata.lastModified))).then(() => {
                        fsLocal.checkLastModified(absolutePath).then(() => {
                            fs.lstat(absolutePath).then((stat) => {
                                if(stat.size <= 0){
                                    fsLocal.rm(absolutePath)
            
                                    return reject(new Error(absolutePath + " size = " + stat.size))
                                }
                                
                                return resolve(stat)
                            }).catch(reject)
                        }).catch(reject)
                    }).catch(reject)
                }).catch(reject)
            }).catch(reject)
        }).catch(reject)
    })
}

const DownloadFolder = memo(({ userId, email, platform, darkMode, lang, args }) => {
    const [downloadPath, setDownloadPath] = useState("")
    const [isDownloading, setIsDownloading] = useState(false)
    const [isGettingTree, setIsGettingTree] = useState(false)
    const [timeLeft, setTimeLeft] = useState(1)
    const [speed, setSpeed] = useState(0)
    const [percent, setPercent] = useState(0)
    const [done, setDone] = useState(false)
    const paused = useDb("paused", false)

    const totalBytes = useRef(0)
    const bytes = useRef(0)
    const started = useRef(-1)

    const startDownloading = useCallback(() => {
        setIsGettingTree(true)

        Promise.all([
            db.get("apiKey"),
            db.get("privateKey"),
            db.get("masterKeys")
        ]).then(async ([apiKey, privateKey, masterKeys]) => {
            apiRequest({
                method: "POST",
                endpoint: args.shared ? ("/v1/download/dir/shared") : (args.linked ? ("/v1/download/dir/link") : ("/v1/download/dir")),
                data: args.shared ? ({
                    apiKey,
                    uuid: args.uuid
                }) : (args.linked ? ({
                    uuid: args.linkUUID,
                    parent: args.uuid,
                    password: typeof password == "string" ? (args.password.length < 32 ? (await ipc.hashFn(args.password)) : args.password) : ""
                }) : ({
                    apiKey,
                    uuid: args.uuid
                }))
            }).then(async (response) => {
                if(!response.status){
                    showToast({ message: response.message, status: "error" })

                    setIsDownloading(false)
                    setIsGettingTree(false)

                    return log.error(new Error(response.message))
                }

                const treeItems = []
                const { uuid: baseFolderUUID, name: baseFolderMetadata, parent: baseFolderParent } = response.data.folders[0]
                const baseFolderName = baseFolderMetadata == "default" ? "Default" : (args.shared ? (await ipc.decryptFolderNamePrivateKey(baseFolderMetadata, privateKey)) : (args.linked ? (await ipc.decryptFolderNameLink(baseFolderMetadata, args.linkKey)) : (await ipc.decryptFolderName(baseFolderMetadata))))
                
                if(baseFolderParent !== "base"){
                    showToast({ message: "Invalid base folder parent", status: "error" })

                    setIsDownloading(false)
                    setIsGettingTree(false)

                    return log.error(new Error("Invalid base folder parent"))
                }

                if(baseFolderName.length <= 0){
                    showToast({ message: "Could not decrypt base folder name", status: "error" })

                    setIsDownloading(false)
                    setIsGettingTree(false)

                    return log.error(new Error("Could not decrypt base folder name"))
                }

                treeItems.push({
                    uuid: baseFolderUUID,
                    name: baseFolderName,
                    parent: "base",
                    type: "folder"
                })

                const addedFolders = {}
                const addedFiles = {}

                for(let i = 0; i < response.data.folders.length; i++){
                    const { uuid, name: metadata, parent } = response.data.folders[i]

                    if(uuid == baseFolderUUID){
                        continue
                    }

                    const name = metadata == "default" ? "Default" : (args.shared ? (await ipc.decryptFolderNamePrivateKey(metadata, privateKey)) : (args.linked ? (await ipc.decryptFolderNameLink(metadata, args.linkKey)) : (await ipc.decryptFolderName(metadata))))

                    if(name.length > 0){
                        if(!addedFolders[parent + ":" + name]){
                            addedFolders[parent + ":" + name] = true

                            treeItems.push({
                                uuid,
                                name,
                                parent,
                                type: "folder"
                            })
                        }
                    }
                }

                for(let i = 0; i < response.data.files.length; i++){
                    const { uuid, bucket, region, chunks, parent, metadata, version, timestamp } = response.data.files[i]
                    const decrypted = args.shared ? (await ipc.decryptFileMetadataPrivateKey(metadata, privateKey)) : (args.linked ? (await ipc.decryptFileMetadataLink(metadata, args.linkKey)) : (await ipc.decryptFileMetadata(metadata, masterKeys)))

                    if(typeof decrypted.lastModified == "number"){
                        if(decrypted.lastModified <= 0){
                            decrypted.lastModified = timestamp
                        }
                    }
                    else{
                        decrypted.lastModified = timestamp
                    }

                    decrypted.lastModified = convertTimestampToMs(decrypted.lastModified)

                    if(decrypted.name.length > 0){
                        if(!addedFiles[parent + ":" + decrypted.name]){
                            addedFiles[parent + ":" + decrypted.name] = true

                            treeItems.push({
                                uuid,
                                region,
                                bucket,
                                chunks,
                                parent,
                                metadata: decrypted,
                                version,
                                type: "file"
                            })

                            totalBytes.current += parseInt(decrypted.size)
                        }
                    }
                }

                const nest = (items, uuid = "base", currentPath = "", link = "parent") => {
                    return items.filter((item) => item[link] == uuid).map((item) => ({ 
                        ...item,
                        path: item.type == "folder" ? (currentPath + "/" + item.name) : (currentPath + "/" + item.metadata.name),
                        children: nest(items, item.uuid, item.type == "folder" ? (currentPath + "/" + item.name) : (currentPath + "/" + item.metadata.name), link)
                    }))
                }

                const tree = nest(treeItems)
                let reading = 0
                const folders = {}
                const files = {}

                const iterateTree = (parent, callback) => {
                    if(parent.type == "folder"){
                        folders[parent.path] = parent
                    }
                    else{
                        files[parent.path] = parent
                    }

                    if(parent.children.length > 0){
                        for(let i = 0; i < parent.children.length; i++){
                            reading += 1
            
                            iterateTree(parent.children[i], callback)
                        }
                    }
            
                    reading -= 1
            
                    if(reading == 0){
                        return callback()
                    }
                }
            
                reading += 1

                iterateTree(tree[0], () => {
                    const newFiles = {}
                    const newFolders = {}

                    for(const prop in files){
                        const newProp = prop.split("/").slice(2).join("/")

                        delete files[prop].children

                        if(newProp.length > 0){
                            newFiles[newProp] = {
                                ...files[prop],
                                path: newProp
                            }
                        }
                    }

                    for(const prop in folders){
                        const newProp = prop.split("/").slice(2).join("/")

                        delete folders[prop].children

                        if(newProp.length > 0){
                            newFolders[newProp] = {
                                ...folders[prop],
                                path: newProp
                            }
                        }
                    }

                    const obj = {
                        files: newFiles,
                        folders: newFolders
                    }

                    const baseDownloadPath = pathModule.normalize(downloadPath)

                    Promise.all([
                        fs.access(pathModule.normalize(pathModule.join(baseDownloadPath, "..")), fs.constants.R_OK | fs.constants.W_OK),
                        fsLocal.smokeTest(pathModule.normalize(pathModule.join(baseDownloadPath, "..")))
                    ]).then(() => {
                        fs.remove(baseDownloadPath, {
                            recursive: true
                        }).then(() => {
                            fs.mkdir(baseDownloadPath, {
                                recursive: true,
                                overwrite: true
                            }).then(async () => {
                                setIsDownloading(true)
                                setIsGettingTree(false)

                                let foldersCreated = 0

                                for(const path in obj.folders){
                                    try{
                                        await fs.mkdir(pathModule.normalize(pathModule.join(baseDownloadPath, path)), {
                                            recursive: true,
                                            overwrite: true
                                        })

                                        foldersCreated += 1
                                    }
                                    catch(e){
                                        log.error(e)

                                        showToast({ message: e.toString(), status: "error" })

                                        continue
                                    }
                                }

                                if(foldersCreated == Object.keys(obj.folders).length){
                                    let filesDownloaded = 0

                                    try{
                                        await Promise.all([...Object.keys(obj.files).map(path => new Promise((resolve, reject) => {
                                            downloadSemaphore.acquire().then(() => {
                                                downloadFile(pathModule.normalize(pathModule.join(baseDownloadPath, path)), obj.files[path]).then(() => {
                                                    downloadSemaphore.release()

                                                    filesDownloaded += 1

                                                    console.log("filesDownloaded", filesDownloaded)

                                                    return resolve(true)
                                                }).catch(reject)
                                            }).catch(reject)
                                        }))])
                                    }
                                    catch(e){
                                        log.error(e)

                                        showToast({ message: e.toString(), status: "error" })
                                    }

                                    setIsDownloading(false)
                                    setDone(true)
                                }
                                else{
                                    setIsDownloading(false)

                                    showToast({ message: "Could not create needed folders locally", status: "error" })

                                    log.error(new Error("Could not create needed folders: " + Object.keys(obj.folders).length + " -> " + foldersCreated))
                                }
                            }).catch((err) => {
                                setIsDownloading(false)
                                setIsGettingTree(false)

                                showToast({ message: err.toString(), status: "error" })

                                log.error(err)
                            })
                        }).catch((err) => {
                            setIsDownloading(false)
                            setIsGettingTree(false)

                            showToast({ message: err.toString(), status: "error" })

                            log.error(err)
                        })
                    }).catch((err) => {
                        setIsDownloading(false)
                        setIsGettingTree(false)

                        showToast({ message: err.toString(), status: "error" })

                        log.error(err)
                    })
                })
            }).catch((err) => {
                setIsDownloading(false)
                setIsGettingTree(false)

                showToast({ message: err.toString(), status: "error" })

                log.error(err)
            })
        }).catch((err) => {
            setIsDownloading(false)
            setIsGettingTree(false)

            showToast({ message: err.toString(), status: "error" })

            log.error(err)
        })
    })

    const calcSpeed = (now, started, bytes) => {
        now = new Date().getTime() - 1000

        const secondsDiff = ((now - started) / 1000)
        const bps = (bytes / secondsDiff)

        return bps > 0 ? bps : 0
    }

    const calcTimeLeft = (loadedBytes, totalBytes, started) => {
        const elapsed = (new Date().getTime() - started)
        const speed = (loadedBytes / (elapsed / 1000))
        const remaining = ((totalBytes - loadedBytes) / speed)

        return remaining > 0 ? remaining : 0
    }

    const throttleUpdates = useCallback(throttle(() => {
        setSpeed(calcSpeed(new Date().getTime(), started.current, bytes.current))
        setPercent(Math.round((bytes.current / totalBytes.current) * 100))
    }, 250), [])

    const throttleTimeLeft = useCallback(throttle(() => {
        setTimeLeft(calcTimeLeft(bytes.current, totalBytes.current, started.current))
    }, 1000), [])

    useEffect(() => {
        ipc.getAppPath("downloads").then((path) => setDownloadPath(pathModule.normalize(pathModule.join(path, args.name)))).catch(log.error)

        const progressListener = eventListener.on("downloadProgressSeperate", (data) => {
            if(data.from == FROM_ID){
                if(started.current == -1){
                    started.current = new Date().getTime()
                }

                bytes.current += parseInt(data.bytes)

                throttleUpdates()
                throttleTimeLeft()
            }
        })

        return () => {
            progressListener.remove()
        }
    }, [])

    return (
        <Flex
            width="100%"
            height="100%"
            justifyContent="center"
            flexDirection="column"
            alignItems="center"
        >
            {
                percent >= 100 && done ? (
                    <>
                        <AiOutlineCheckCircle color="green" size={64} />
                        <Text 
                            fontSize={14}
                            color={colors(platform, darkMode, "textPrimary")}
                            noOfLines={1}
                            marginTop="10px"
                        >
                            {i18n(lang, "downloadDone")}
                        </Text>
                        <Link 
                            color={colors(platform, darkMode, "link")} 
                            textDecoration="none" 
                            _hover={{ textDecoration: "none" }} 
                            onClick={() => shell.openPath(downloadPath)}
                            marginTop="15px"
                        >
                            {i18n(lang, "openFolder")}
                        </Link>
                    </>
                ) : (
                    <>
                        <Flex
                            borderBottom={"1px solid " + colors(platform, darkMode, "borderPrimary")}
                            width="80%"
                            height="35px"
                        >
                            <Text
                                fontSize={22}
                                color={colors(platform, darkMode, "textPrimary")}
                                noOfLines={1}
                                width="100%"
                            >
                                {i18n(lang, "download")} {args.name}
                            </Text>
                        </Flex>
                        <Flex
                            width="80%"
                            marginTop="15px"
                        >
                            <InputGroup>
                                <Input
                                    type="text"
                                    value={downloadPath}
                                    paddingRight="150px"
                                    noOfLines={1}
                                    userSelect="none"
                                    border="none"
                                    backgroundColor={darkMode ? "#171717" : "lightgray"}
                                    color="gray"
                                    _placeholder={{
                                        color: "gray"
                                    }}
                                    _disabled={{
                                        color: "gray",
                                        backgroundColor: darkMode ? "#171717" : "lightgray"
                                    }}
                                    disabled={true}
                                />
                                <InputRightElement
                                    width="auto"
                                    paddingRight="5px"
                                >
                                    <Button
                                        height="1.75rem"
                                        size="sm"
                                        backgroundColor={darkMode ? "gray" : "lightgray"}
                                        color={darkMode ? "white" : "gray"}
                                        _hover={{
                                            color: darkMode ? "black" : "gray"
                                        }}
                                        onClick={() => {
                                            ipc.selectFolder().then((result) => {
                                                if(result.canceled){
                                                    return false
                                                }
                                    
                                                const paths = result.filePaths
                                    
                                                if(!Array.isArray(paths)){
                                                    return false
                                                }
                                    
                                                const localPath = pathModule.normalize(paths[0])
                                    
                                                if(typeof localPath !== "string"){
                                                    return false
                                                }

                                                Promise.all([
                                                    fs.access(localPath, fs.constants.R_OK | fs.constants.W_OK),
                                                    fsLocal.smokeTest(localPath)
                                                ]).then(() => {
                                                    setDownloadPath(pathModule.normalize(pathModule.join(localPath, args.name)))
                                                }).catch((err) => {
                                                    log.error(err)
                                                })
                                            }).catch(log.error)
                                        }}
                                        disabled={isGettingTree || isDownloading}
                                    >
                                        {i18n(lang, "change")}
                                    </Button>
                                    <Button
                                        height="1.75rem"
                                        size="sm"
                                        marginLeft="5px"
                                        backgroundColor={darkMode ? "gray" : "lightgray"}
                                        color={darkMode ? "white" : "gray"}
                                        _hover={{
                                            color: darkMode ? "black" : "gray"
                                        }}
                                        onClick={() => shell.openPath(pathModule.normalize(downloadPath)).catch(log.error)}
                                        disabled={isGettingTree || isDownloading}
                                    >
                                        {i18n(lang, "open")}
                                    </Button>
                                </InputRightElement>
                            </InputGroup>
                        </Flex>
                        <Flex
                            width="80%"
                            marginTop="20px"
                        >
                            <Button
                                height="1.75rem"
                                size="sm"
                                backgroundColor={darkMode ? "gray" : "lightgray"}
                                color={darkMode ? "white" : "gray"}
                                _hover={{
                                    color: darkMode ? "black" : "gray"
                                }}
                                onClick={() => startDownloading()}
                                disabled={isGettingTree || isDownloading}
                            >
                                {
                                    isGettingTree || isDownloading ? (
                                        <Spinner
                                            color={darkMode ? "white" : "gray"}
                                            width="16px"
                                            height="16px"
                                        />
                                    ) : i18n(lang, "download")
                                }
                            </Button>
                        </Flex>
                        {
                            percent > 0 && !done && (
                                <Flex
                                    marginTop="25px"
                                    width="80%"
                                    height="auto"
                                    flexDirection="column"
                                >
                                    <Progress
                                        value={percent > 100 ? 100 : percent.toFixed(2)}
                                        height="5px"
                                        borderRadius="10px"
                                        colorScheme="blue"
                                        min={0}
                                        max={100}
                                        marginTop="5px"
                                        width="100%"
                                    />
                                    <Flex
                                        flexDirection="row"
                                        justifyContent="space-between"
                                        marginTop="2px"
                                    >
                                        {
                                            paused ? (
                                                <Spinner
                                                    width="14px"
                                                    height="14px"
                                                    color={colors(platform, darkMode, "textPrimary")}
                                                    marginTop="5px"
                                                />
                                            ) : (() => {
                                                const remainingReadable = getTimeRemaining((new Date().getTime() + (timeLeft * 1000)))

                                                if(remainingReadable.total <= 1 || remainingReadable.minutes <= 1){
                                                    remainingReadable.total = 1
                                                    remainingReadable.days = 0
                                                    remainingReadable.hours = 0
                                                    remainingReadable.minutes = 1
                                                    remainingReadable.seconds = 1
                                                }

                                                return (
                                                    <Text 
                                                        fontSize={14}
                                                        color={colors(platform, darkMode, "textPrimary")}
                                                        noOfLines={1}
                                                    >
                                                        {bpsToReadable(speed) + ", " + i18n(lang, "aboutRemaining", false, ["__TIME__"], [(remainingReadable.days > 0 ? remainingReadable.days + "d " : "") + (remainingReadable.hours > 0 ? remainingReadable.hours + "h " : "") + (remainingReadable.minutes > 0 ? remainingReadable.minutes + "m " : "")])}
                                                    </Text>
                                                )
                                            })()
                                        }
                                        {
                                            percent < 100 && !done && (
                                                <>
                                                    {
                                                        paused ? (
                                                            <Link 
                                                                color={colors(platform, darkMode, "link")} 
                                                                textDecoration="none" 
                                                                _hover={{ textDecoration: "none" }} 
                                                                marginLeft="10px" 
                                                                onClick={() => db.set("paused", false)}
                                                            >
                                                                {i18n(lang, "resume")}
                                                            </Link>
                                                        ) : (
                                                            <Link 
                                                                color={colors(platform, darkMode, "link")} 
                                                                textDecoration="none" 
                                                                _hover={{ textDecoration: "none" }} 
                                                                marginLeft="10px" 
                                                                onClick={() => db.set("paused", true)}
                                                            >
                                                                {i18n(lang, "pause")}
                                                            </Link>
                                                        )
                                                    }
                                                </>
                                            )
                                        }
                                    </Flex>
                                </Flex>
                            )
                        }
                    </>
                )
            }
        </Flex>
    )
})

const DownloadFile = memo(({ userId, email, platform, darkMode, lang, args }) => {
    const [downloadPath, setDownloadPath] = useState("")
    const [isDownloading, setIsDownloading] = useState(false)
    const paused = useDb("paused", false)

    const startDownloading = useCallback(() => {
        setIsDownloading(true)

        Promise.all([
            fs.access(downloadPath, fs.constants.R_OK | fs.constants.W_OK),
            fsLocal.smokeTest(downloadPath)
        ]).then(() => {
            fs.remove(downloadPath).then(() => {
                downloadFile(downloadPath, args.file).then(() => {
                    setIsDownloading(false)
                }).catch((err) => {
                    setIsDownloading(false)

                    log.error(err)
                })
            }).catch((err) => {
                setIsDownloading(false)

                log.error(err)
            })
        }).catch((err) => {
            setIsDownloading(false)

            log.error(err)
        })
    })

    useEffect(() => {
        ipc.getAppPath("downloads").then((path) => setDownloadPath(pathModule.normalize(pathModule.join(path, args.name)))).catch(log.error)
    }, [])

    return (
        <Flex
            width="100%"
            height="100%"
            justifyContent="center"
            flexDirection="column"
            alignItems="center"
        >
            <Flex
                borderBottom={"1px solid " + colors(platform, darkMode, "borderPrimary")}
                width="80%"
                height="35px"
            >
                <Text
                    fontSize={22}
                    color={colors(platform, darkMode, "textPrimary")}
                    noOfLines={1}
                    width="100%"
                >
                    {i18n(lang, "download")} {args.name}
                </Text>
            </Flex>
            <Flex
                width="80%"
                marginTop="10px"
            >
                <InputGroup>
                    <Input
                        type="text"
                        value={downloadPath}
                        paddingRight="80px"
                        noOfLines={1}
                        userSelect="none"
                        border="none"
                        backgroundColor={darkMode ? "#171717" : "lightgray"}
                        color="gray"
                        _placeholder={{
                            color: "gray"
                        }}
                        _disabled={{
                            color: "gray",
                            backgroundColor: darkMode ? "#171717" : "lightgray"
                        }}
                        disabled={true}
                    />
                    <InputRightElement
                        width="auto"
                        paddingRight="5px"
                    >
                        <Button
                            height="1.75rem"
                            size="sm"
                            backgroundColor={darkMode ? "gray" : "lightgray"}
                            color={darkMode ? "white" : "gray"}
                            _hover={{
                                color: darkMode ? "black" : "gray"
                            }}
                            onClick={() => {
                                ipc.selectFolder().then((result) => {
                                    if(result.canceled){
                                        return false
                                    }
                        
                                    const paths = result.filePaths
                        
                                    if(!Array.isArray(paths)){
                                        return false
                                    }
                        
                                    const localPath = pathModule.normalize(paths[0])
                        
                                    if(typeof localPath !== "string"){
                                        return false
                                    }

                                    Promise.all([
                                        fs.access(localPath, fs.constants.R_OK | fs.constants.W_OK),
                                        fsLocal.smokeTest(localPath)
                                    ]).then(() => {
                                        setDownloadPath(pathModule.normalize(pathModule.join(localPath, args.name)))
                                    }).catch((err) => {
                                        log.error(err)
                                    })
                                }).catch(log.error)
                            }}
                            disabled={isDownloading}
                        >
                            {i18n(lang, "change")}
                        </Button>
                        <Button
                            height="1.75rem"
                            size="sm"
                            marginLeft="5px"
                            backgroundColor={darkMode ? "gray" : "lightgray"}
                            color={darkMode ? "white" : "gray"}
                            _hover={{
                                color: darkMode ? "black" : "gray"
                            }}
                            onClick={() => shell.openPath(pathModule.normalize(pathModule.join(downloadPath, ".."))).catch(log.error)}
                            disabled={isDownloading}
                        >
                            {i18n(lang, "open")}
                        </Button>
                    </InputRightElement>
                </InputGroup>
            </Flex>
            <Flex
                width="80%"
                marginTop="20px"
            >
                <Button
                    height="1.75rem"
                    size="sm"
                    backgroundColor={darkMode ? "gray" : "lightgray"}
                    color={darkMode ? "white" : "gray"}
                    _hover={{
                        color: darkMode ? "black" : "gray"
                    }}
                    onClick={() => startDownloading()}
                    disabled={isDownloading}
                >
                    {
                        isDownloading ? (
                            <Spinner
                                color={darkMode ? "white" : "gray"}
                                width="16px"
                                height="16px"
                            />
                        ) : i18n(lang, "download")
                    }
                </Button>
            </Flex>
        </Flex>
    )
})

const DownloadWindow = memo(({ userId, email, windowId }) => {
    const darkMode = useDarkMode()
    const lang = useLang()
    const platform = usePlatform()
    const args = useRef(passedArgs).current

    useEffect(() => {
        ipcRenderer.send("window-ready", windowId)
    }, [])

    return (
        <Container
            darkMode={darkMode}
            lang={lang}
            platform={platform}
        >
            <Titlebar
                darkMode={darkMode}
                lang={lang}
                platform={platform}
                title={i18n(lang, "titlebarDownload")}
            />
            {
                userId !== 0 && typeof args == "object" && (
                    <Flex
                        width="100%"
                        height="380px"
                        paddingTop="25px"
                    >
                        {
                            args.type == "download-folder" && (
                                <DownloadFolder
                                    darkMode={darkMode}
                                    lang={lang}
                                    platform={platform}
                                    userId={userId}
                                    email={email}
                                    args={args}
                                />
                            )
                        }
                        {
                            args.type == "download-file" && (
                                <DownloadFile
                                    darkMode={darkMode}
                                    lang={lang}
                                    platform={platform}
                                    userId={userId}
                                    email={email}
                                    args={args}
                                />
                            )
                        }
                    </Flex>
                )
            }
            <IsOnlineBottomToast
                userId={userId}
                email={email}
                platform={platform}
                darkMode={darkMode}
                lang={lang}
            />
        </Container>
    )
})

export default DownloadWindow