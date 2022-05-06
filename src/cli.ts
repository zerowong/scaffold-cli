import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import chalk from 'chalk'
import {
  error,
  log,
  rmrf,
  cp,
  exists,
  parse,
  fetchHeadHash,
  joinGithubArchiveUrl,
  download,
  unzip,
  argsParser,
} from './utils'

export interface Project {
  path: string
  remote?: string
  hash?: string
}

const cwd = process.cwd()

export default class ScaffoldCli {
  private configDir: string
  private storeFile: string
  private cacheDir: string
  private store: Record<string, Project>
  private changes: Record<string, Project>

  constructor() {
    const isTest = process.env.NODE_ENV === 'test'
    this.configDir = path.join(
      os.homedir(),
      isTest ? '.scaffold-cli-test' : '.scaffold-cli'
    )
    this.storeFile = path.join(this.configDir, 'store.json')
    this.cacheDir = path.join(this.configDir, 'cache')
    this.store = {}
    this.changes = {}
  }

  private async init() {
    if (await exists(this.configDir)) {
      const raw = await fsp.readFile(this.storeFile, { encoding: 'utf8' })
      this.store = JSON.parse(raw)
    } else {
      await fsp.mkdir(this.configDir)
      await fsp.mkdir(this.cacheDir)
      await this.save()
    }
  }

  private async save() {
    await fsp.writeFile(this.storeFile, JSON.stringify(this.store, null, 2))
  }

  private addProject(name: string, proj: Project) {
    this.store[name] = proj
    this.changes[`${chalk.green('+')} ${name}`] = proj
  }

  private removeProject(name: string) {
    this.changes[`${chalk.red('-')} ${name}`] = this.store[name]
    delete this.store[name]
  }

  private logChanges() {
    log.grid(
      Object.entries(this.changes).map(([name, proj]) => {
        return [name, proj.path]
      })
    )
  }

  private async none(flags: { h?: boolean; v?: boolean }) {
    if (flags.h || Object.keys(flags).length === 0) {
      log.grid(
        [
          ['scaffold', '[-h|--help] [-v|--version]'],
          ['', '<command> [<flags>]'],
        ],
        1
      )
      console.log('\nAvailable commands are as follows:\n')
      log.grid([
        ['list [-p|--prune]', 'List all projects.'],
        [
          'add <path ...> [-d|--depth <0|1>]',
          'Add projects with path of a local folder.',
        ],
        ['remove <name ...>', 'Remove projects from list.'],
        [
          'create <name> [<directory>] [-o|--overwrite]',
          'Create a project by copying the templates folder.',
        ],
      ])
    }
    if (flags.v) {
      const raw = await fsp.readFile(path.join(__dirname, '../package.json'), {
        encoding: 'utf8',
      })
      const pkg = JSON.parse(raw)
      console.log(pkg.version)
    }
  }

  private async list(prune: boolean) {
    const entries = Object.entries(this.store)
    if (prune) {
      for (const [name, proj] of entries) {
        if (!(await exists(proj.path))) {
          delete this.store[name]
        }
      }
      await this.save()
    }
    log.grid(
      Object.entries(this.store).map(([name, proj]) => {
        return [chalk.green(name), proj.path]
      })
    )
  }

  private async add(paths: string[], depth = 0) {
    for (const src of paths) {
      const repo = parse(src)
      if (repo) {
        const hash = await fetchHeadHash(src)
        if (!hash) {
          return log.error(`Could not find commit hash of HEAD from ${chalk.green(src)}.`)
        }
        const url = joinGithubArchiveUrl(repo.url, hash)
        const archiveFile = path.join(this.cacheDir, `${repo.name}-${hash}.zip`)
        try {
          log.write(log.info('Downloading...', true))
          await download(url, archiveFile, { proxy: process.env.https_proxy })
          const unzipedDir = await unzip(archiveFile)
          if (depth === 0) {
            this.addProject(repo.name, { path: unzipedDir, remote: src, hash })
          } else if (depth === 1) {
            await this.add([unzipedDir], 1)
            return
          }
        } catch (err) {
          return console.error(err)
        }
      } else {
        if (src.startsWith('https://')) {
          return log.error('Invalid GitHub url')
        }
        const absPath = path.isAbsolute(src) ? src : path.resolve(cwd, src)
        try {
          if (depth === 0) {
            const target = await fsp.stat(absPath)
            if (!target.isDirectory()) {
              return log.error(`'${absPath}' is not a directory.`)
            }
            this.addProject(path.basename(absPath), { path: absPath })
          } else if (depth === 1) {
            const dir = await fsp.opendir(absPath)
            for await (const dirent of dir) {
              if (dirent.isDirectory() && dirent.name[0] !== '.') {
                this.addProject(dirent.name, { path: path.join(absPath, dirent.name) })
              }
            }
          }
        } catch (e) {
          if (error.isENOENT(e)) {
            return log.error(`Can't find directory '${e.path}'.`)
          }
        }
      }
    }
    await this.save()
    log.clear()
    this.logChanges()
  }

  private async remove(names: string[]) {
    for (const name of names) {
      if (!(name in this.store)) {
        return log.error(`No such project: '${name}'.`)
      }
      this.removeProject(name)
    }
    await this.save()
    this.logChanges()
  }

  private async create(name: string, directory?: string, overwrite = false) {
    const proj = this.store[name]
    if (!proj) {
      return log.error(`Can't find project '${name}'.`)
    }
    if (proj.remote) {
      const newHash = await fetchHeadHash(proj.remote)
      if (!newHash) {
        log.warn('Could not find commit hash of HEAD, Local cache will be used.')
      } else {
        const repo = parse(proj.remote)
        if (newHash !== proj.hash && repo) {
          log.write(log.info('The cache needs to be updated, downloading...', true))
          const url = joinGithubArchiveUrl(repo.url, newHash)
          const archiveFile = path.join(this.cacheDir, `${repo.name}-${newHash}.zip`)
          await download(url, archiveFile, { proxy: process.env.https_proxy })
          await unzip(archiveFile)
          this.addProject(name, {
            path: proj.path,
            remote: proj.remote,
            hash: newHash,
          })
          await this.save()
        }
      }
    }
    const source = proj.path
    const target = path.resolve(cwd, directory ?? name)
    if (target === source) {
      return log.error(`Source path and target paths cannot be the same.`)
    }
    if (overwrite) {
      await rmrf(target)
    }
    try {
      await cp(source, target)
      log.clear()
      log.info(`Project created in '${target}'.`)
    } catch (e) {
      if (error.isEEXIST(e)) {
        log.error(`Directory '${e.path}' already exists.`)
      }
      if (error.isENOENT(e)) {
        log.error(`Can't find directory '${e.path}'.`)
      }
    }
  }

  async main() {
    await this.init()
    const argv = argsParser()

    if (!argv) {
      return
    }

    const { action, args, flags, checker } = argv

    switch (action) {
      case '': {
        if (checker(['v', 'h'])) {
          return log.usage('scaffold [-h|--help] [-v|--version]')
        }
        this.none(flags)
        break
      }
      case 'list': {
        if (checker(['p'])) {
          return log.usage('scaffold list [-p|--prune]')
        }
        this.list(flags.p)
        break
      }
      case 'add': {
        if (args.length === 0 || checker({ flag: 'd', options: [0, 1] })) {
          return log.usage('scaffold add <path ...> [-d|--depth <0|1>]')
        }
        this.add(args, flags.d)
        break
      }
      case 'remove': {
        if (args.length === 0) {
          return log.usage('scaffold remove <name ...>')
        }
        this.remove(args)
        break
      }
      case 'create': {
        if (args.length < 1 || checker(['o'])) {
          return log.usage('scaffold create <name> [<directory>] [-o|--overwrite]')
        }
        this.create(args[0], args[1], flags.o)
        break
      }
      default: {
        log.error(`'${action}' is not a valid command. See 'scaffold --help'.`)
        break
      }
    }
  }
}