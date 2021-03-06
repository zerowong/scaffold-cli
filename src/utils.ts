import path from 'node:path'
import fsp from 'node:fs/promises'
import child_process from 'node:child_process'
import https from 'node:https'
import fs from 'node:fs'
import chalk from 'chalk'
import createHttpsProxyAgent from 'https-proxy-agent'
import StreamZip from 'node-stream-zip'
import mri from 'mri'

interface SystemError extends Error {
  code: string
  syscall: string
  path: string
}

export interface Repo {
  user: string
  name: string
  hash: string
}

const isTTY = process.stdout.isTTY

function isSystemError(err: unknown): err is SystemError {
  return err instanceof Error && hasOwn(err, 'syscall')
}

export const exception = {
  isENOENT(err: unknown): err is SystemError {
    return isSystemError(err) && err.code === 'ENOENT'
  },
  isEEXIST(err: unknown): err is SystemError {
    return isSystemError(err) && err.code === 'EEXIST'
  },
}

export const log = {
  info(msg: string) {
    console.log(`${chalk.bold.cyan('INFO')}: ${msg}`)
  },
  error(msg: string) {
    console.log(`${chalk.bold.red('ERROR')}: ${msg}`)
  },
  usage(msg: string) {
    console.log(`${chalk.bold.cyan('USAGE')}: ${msg}`)
  },
  warn(msg: string) {
    console.log(`${chalk.bold.yellow('WARN')}: ${msg}`)
  },
  grid(msgs: [string, string][], space = 4) {
    const max = msgs.reduce((prev, curr) => {
      return Math.max(curr[0].length, prev)
    }, 0)
    const res = msgs.reduce(
      (prev, curr, i) =>
        `${prev}${curr[0].padEnd(max + space)}${curr[1]}${
          i === msgs.length - 1 ? '' : '\n'
        }`,
      ''
    )
    if (!res) {
      return
    }
    console.log(res)
  },
  write(msg: string) {
    if (isTTY) {
      process.stdout.write(msg)
    }
  },
  clear() {
    if (isTTY) {
      process.stdout.clearLine(0)
      process.stdout.cursorTo(0)
    }
  },
  result(taskResult: PromiseSettledResult<void>[]) {
    const result = { success: 0, failed: [] as string[] }
    taskResult.forEach((res) => {
      if (res.status === 'fulfilled') {
        result.success += 1
      } else {
        if (exception.isENOENT(res.reason)) {
          result.failed.push(`Can't find directory '${res.reason.path}'.`)
        } else {
          result.failed.push(res.reason.message)
        }
      }
    })
    const str = result.failed.reduce(
      (prev, curr) => `${prev}\n${chalk.bold.red('ERROR')}: ${curr}`,
      `${chalk.bold.cyan('INFO')}: ${chalk.green(result.success)} success, ${chalk.red(
        result.failed.length
      )} fail.`
    )
    console.log(str)
  },
}

export function rmrf(target: string) {
  return fsp.rm(target, { force: true, recursive: true })
}

// fsPromises.cp is experimental
export async function cp(source: string, target: string) {
  const ignore = ['.git', '.DS_Store', 'node_modules']
  const sourceDir = await fsp.readdir(source, { withFileTypes: true })
  await fsp.mkdir(target)
  for (const dirent of sourceDir) {
    if (ignore.includes(dirent.name)) {
      continue
    }
    const s = path.join(source, dirent.name)
    const t = path.join(target, dirent.name)
    if (dirent.isDirectory()) {
      await cp(s, t)
    } else if (dirent.isFile()) {
      await fsp.copyFile(s, t)
    }
  }
}

export async function exists(target: string) {
  try {
    await fsp.access(target)
  } catch {
    return false
  }
  return true
}

export async function parse(src: string): Promise<Repo> {
  const regexp = /^https:\/\/github.com\/(?<user>[^/\s]+)\/(?<name>[^/\s]+)\.git$/
  const match = src.match(regexp)
  if (!match || !match.groups) {
    throw new Error('Invalid GitHub url')
  }
  const hash = await fetchHeadHash(src)
  return { user: match.groups.user, name: match.groups.name, hash }
}

function fetchHeadHash(src: string) {
  return new Promise<string>((resolve, reject) => {
    child_process.execFile('git', ['ls-remote', src], (err, stdout) => {
      if (err) {
        return reject(err)
      }
      const blank = stdout.indexOf('\t')
      if (blank === -1) {
        return reject(
          new Error(`Could not find commit hash of HEAD from ${chalk.green(src)}.`)
        )
      }
      return resolve(stdout.slice(0, blank))
    })
  })
}

function download(
  url: string,
  dest: string,
  options = { proxy: process.env.https_proxy }
) {
  const { proxy } = options
  const agent = proxy ? createHttpsProxyAgent(proxy) : undefined
  return new Promise<void>((resolve, reject) => {
    https
      .get(url, { agent }, (res) => {
        const { statusCode, statusMessage } = res
        if (!statusCode) {
          return reject(new Error('No response.'))
        }
        if (statusCode < 300 && statusCode >= 200) {
          res.pipe(fs.createWriteStream(dest)).on('finish', resolve).on('error', reject)
        } else if (statusCode < 400 && statusCode >= 300 && res.headers.location) {
          download(res.headers.location, dest, { proxy }).then(resolve, reject)
        } else {
          reject(new Error(`${statusCode}: ${statusMessage}.`))
        }
      })
      .on('error', reject)
  })
}

/**
 * in-place unzip and rename
 * @param file archive zip file that name must be with hash
 * @returns the full directory path path of unziped dir
 */
async function unzip(file: string) {
  const { dir, name } = path.parse(file)
  const zip = new StreamZip.async({ file })
  await zip.extract(null, dir)
  await zip.close()
  await fsp.rm(file)
  const index = name.lastIndexOf('-')
  const extractPath = path.join(dir, name)
  const fullPath = index === -1 ? file : path.join(dir, name.slice(0, index))
  await rmrf(fullPath)
  await fsp.rename(extractPath, fullPath)
  return fullPath
}

export type Validate = string[] | { flag: string; options: number[] }

export function argvParser() {
  const mriArgv = mri(process.argv.slice(2), {
    alias: {
      d: 'depth',
      h: 'help',
      v: 'version',
      o: 'overwrite',
      p: 'prune',
    },
    unknown(flag) {
      log.error(`'${flag}' is not a valid flag. See 'scaffold --help'.`)
    },
  })

  if (!mriArgv) {
    return
  }

  const {
    _: [action = '', ...args],
    ...flags
  } = mriArgv

  /**
   * @returns `true` when no pass
   */
  const checker = (validate: Validate) => {
    if (Array.isArray(validate)) {
      const res = validate.filter(
        (flag) => flags[flag] !== undefined && typeof flags[flag] === 'boolean'
      )
      return !(res.length === 0 || res.length === 1)
    }
    const { flag, options } = validate
    const value = flags[flag]
    return !!value && options.indexOf(value) === -1
  }

  return { action, args, flags, checker }
}

export function isURL(arg: string) {
  return /^(?:https?:\/\/)(?:[\S])+$/.test(arg)
}

export class Key {
  private value: Record<string, number> = {}

  gen(name: string) {
    if (!hasOwn(this.value, name)) {
      this.value[name] = 1
    }
    return this.value[name]++
  }
}

export function hasOwn(obj: object, key: string) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

export function uniq(arr: string[]) {
  return Array.from(new Set(arr))
}

export async function fetchRepo(parentDir: string, repo: Repo) {
  const url = `https://github.com/${repo.user}/${repo.name}/archive/${repo.hash}.zip`
  const file = path.join(parentDir, `${repo.name}-${repo.hash}.zip`)
  await download(url, file)
  const fullPath = await unzip(file)
  return fullPath
}
