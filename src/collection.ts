import sqlite from 'sqlite'
import Emittery from 'emittery'

import { ISqliteMeta, IPropRow } from './decorators'
import { Db } from './db'
import { safeColumnName, safeId, SqliteExt, AliasToSqliteType } from './utils'

interface ITransformer<T> {
  get: (repr: any) => T | null
  set: (data: T) => any
}

type ICollectionMeta<T> = {
  fields: Array<keyof T | '_id'>
  transform: Record<SqliteExt, ITransformer<any>>
} & ISqliteMeta<T>

export interface ISql {
  $statement: string
  $params: Record<string, any>
}

export class Collection<T> extends Emittery.Typed<{
  'build-sql': ISql
  'pre-create': {
    entry: T
    options: {
      postfix: string[]
    }
  }
  'create-sql': ISql
  'pre-find': {
    cond: Record<string, any>
    /**
     * Fields are mostly `keyof T`, but can also be functions, like `COUNT(_id)`
     */
    fields: Record<string, string>
    options: {
      postfix: string[]
    }
  }
  'find-sql': ISql
  'pre-update': {
    cond: Record<string, any>
    set: Partial<T>
    options: {
      postfix: string[]
    }
  }
  'update-sql': ISql
  'pre-delete': {
    cond: Record<string, any>
    options: {
      postfix: string[]
    }
  }
  'delete-sql': ISql
}> {
  static make<T> (T: { new(): T }) {
    const t = new T()
    return new Collection(t)
  }

  static async init (db: Db, cols: Collection<any>[], build = true) {
    for (const c of cols) {
      await c.init(db, build)
    }
  }

  __meta: ICollectionMeta<T>

  sql!: sqlite.Database
  name: string

  constructor (model: T) {
    super()
    const { name, primary, unique, prop, createdAt, updatedAt } = (model as any).__meta as ISqliteMeta<T>

    this.name = name
    const fields: (keyof T | '_id')[] = []
    if (primary.name) {
      if (Array.isArray(primary.name)) {
        fields.push(...primary.name as any[])
      } else {
        fields.push(primary.name as any)
      }
    }
    fields.push(...Object.keys(prop) as any[])

    this.__meta = {
      name,
      primary,
      prop: {
        ...prop,
        createdAt: createdAt ? { type: 'Date', null: false, default: () => new Date() } : undefined,
        updatedAt: updatedAt ? {
          type: 'Date',
          null: false,
          default: () => new Date(),
          onUpdate: () => new Date(),
        } : undefined,
      },
      fields,
      unique,
      transform: {
        Date: {
          get: (repr) => typeof repr === 'number' ? new Date(repr) : null,
          set: (d) => d ? d instanceof Date ? +d : +new Date(d) : null,
        },
        JSON: {
          get: (repr) => repr ? JSON.parse(repr) : null,
          set: (data) => data ? JSON.stringify(data) : null,
        },
        StringArray: {
          get: (repr?: string) => (() => {
            repr = repr ? repr.substr(1, repr.length - 2) : ''
            return repr ? repr.split('\x1f') : null
          })(),
          set: (d) => d ? '\x1f' + d.join('\x1f') + '\x1f' : null,
        },
        Boolean: {
          get: (repr) => typeof repr === 'number' ? repr !== 0 : null,
          set: (d) => typeof d === 'boolean' ? Number(d) : null,
        },
      },
      createdAt,
      updatedAt,
    }

    Object.entries(this.__meta.prop).map(([k, v]) => {
      if (v) {
        const { onUpdate } = v as any

        if (onUpdate) {
          this.on('pre-update', async ({ set }) => {
            (set as any)[k] = (set as any)[k] || (typeof onUpdate === 'function' ? await onUpdate(set) : v)
          })
        }
      }
    })
  }

  /**
   * Normally, you don't have to call this method. It is automatically built on `await db.collection()`
   *
   * Has no effect if call repeatedly.
   */
  async init (db: Db, build = true) {
    this.sql = db.sql
    if (!build) {
      return this
    }

    const getDefault = (k: string, v: {
      default?: any
      type?: keyof typeof AliasToSqliteType
    }) => {
      if (typeof v.default === 'undefined') {
        return ''
      } else if (typeof v.default === 'string') {
        return `DEFAULT '${v.default.replace(/'/g, "[']")}'`
      } else if (typeof v.default === 'number') {
        return `DEFAULT ${v.default}`
      } else if (typeof v.default === 'boolean') {
        return `DEFAULT ${v.default ? 1 : 0}`
      } else if (typeof v.default === 'function') {
        this.on('pre-create', async ({ entry }) => {
          (entry as any)[k] = (entry as any)[k] || await v.default!(entry)
        })
        return ''
      } else if (v.type && (this.__meta.transform as any)[v.type]) {
        return `DEFAULT ${(this.__meta.transform as any)[v.type].set(v.default)}`
      }

      return ''
    }

    const col: string[] = []

    if (this.__meta.primary.type) {
      col.push([
        safeColumnName(this.__meta.primary.name as string),
        AliasToSqliteType[this.__meta.primary.type as keyof typeof AliasToSqliteType] || 'INTEGER',
        'PRIMARY KEY',
        this.__meta.primary.autoincrement ? 'AUTOINCREMENT' : '',
        getDefault(this.__meta.primary.name as string, this.__meta.primary),
      ].join(' '))
    }

    for (const [k, v] of Object.entries<IPropRow>(this.__meta.prop as any)) {
      if (v && v.type) {
        col.push([
          safeColumnName(k),
          AliasToSqliteType[v.type as keyof typeof AliasToSqliteType] || 'TEXT',
          v.unique ? 'UNIQUE' : '',
          v.null ? '' : 'NOT NULL',
          getDefault(k, v),
          v.references ? `REFERENCES ${safeColumnName(v.references)}` : '',
        ].join(' '))
      }
    }

    if (Array.isArray(this.__meta.primary.name)) {
      col.push([
        'PRIMARY KEY',
        `(${this.__meta.primary.name.map((k) => safeColumnName(k as string)).join(',')})`,
      ].join(' '))
    }

    if (this.__meta.unique && this.__meta.unique.length > 0) {
      this.__meta.unique.forEach((ss) => {
        col.push([
          'UNIQUE',
          `(${ss.map((k) => safeColumnName(k as string)).join(',')})`,
        ].join(' '))
      })
    }

    const sql: ISql = {
      $statement: [
        'CREATE TABLE IF NOT EXISTS',
        safeColumnName(this.name),
        `(${col.join(',')})`,
      ].join(' '),
      $params: [],
    }

    await this.emit('build-sql', sql)
    await this.sql.exec(sql.$statement)

    for (const [k, v] of Object.entries<IPropRow>(this.__meta.prop as any)) {
      if (v && v.index) {
        const sql: ISql = {
          $statement: [
            'CREATE INDEX IF NOT EXISTS',
            `${k}__idx`,
            'ON',
            `${safeColumnName(this.name)}`,
            `(${safeColumnName(k)})`,
          ].join(' '),
          $params: [],
        }

        await this.emit('build-sql', sql)
        await this.sql.exec(sql.$statement)
      }
    }

    return this
  }

  /**
   * The standard INSERT command
   *
   * @param entry The entry to insert
   * @param options
   */
  async create (
    entry: T,
    options: {
      postfix?: string
      ignoreErrors?: boolean
    } = {},
  ): Promise<number> {
    const postfix = options.postfix ? [options.postfix] : []

    if (options.ignoreErrors) {
      postfix.push('ON CONFLICT DO NOTHING')
    }

    await this.emit('pre-create', { entry, options: { postfix } })

    const bracketed: string[] = []
    const values: Record<string, any> = {}

    for (let [k, v] of Object.entries(entry)) {
      const prop = (this.__meta.prop as any)[k]
      if (prop && prop.type) {
        const tr = (this.__meta.transform as any)[prop.type]
        if (tr) {
          v = tr.set(v)
        }
      }

      bracketed.push(k)
      Object.assign(values, { [`$${safeId()}`]: v })
    }

    const sql = {
      $statement: [
        `INSERT INTO ${safeColumnName(this.name)}`,
        `(${bracketed.map(safeColumnName).join(',')})`,
        `VALUES (${Object.keys(values).join(',')})`,
        ...postfix,
      ].join(' '),
      $params: values,
    }

    await this.emit('create-sql', sql)
    const r = await this.sql.run(sql.$statement, sql.$params)

    return r.lastID
  }

  /**
   *
   * @param cond Put in `{ $statement: string, $params: any[] }` to directly use SQL
   * @param fields Put in empty array or `null` to select all fields. `COUNT(_id)` is also allowed.
   * @param options
   */
  async find (
    cond: Record<string, any>,
    fields?: string[] | Record<string, string> | null,
    options: {
      postfix?: string
      sort?: {
        key: keyof T
        desc?: boolean
      }
      offset?: number
      limit?: number
    } = {},
  ): Promise<any[]> {
    if (!fields) {
      fields = {}
    }
    if (Array.isArray(fields)) {
      fields = fields.map((c) => c.split('.')[0]).reduce((prev, c) => ({ ...prev, [c]: c }), {})
    }

    const postfix = options.postfix ? [options.postfix] : []
    if (options.sort) {
      postfix.push(`ORDER BY ${safeColumnName(options.sort.key as string)} ${options.sort.desc ? 'DESC' : 'ASC'}`)
    }
    if (options.limit) {
      postfix.push(`LIMIT ${options.limit}`)
    }
    if (options.offset) {
      postfix.push(`OFFSET ${options.offset}`)
    }

    await this.emit('pre-find', { cond, fields, options: { postfix } })

    const where = _parseCond(cond, {
      [this.name]: this,
    })

    const selectClause: string[] = []

    if (Object.keys(fields).length > 0) {
      Object.entries(fields).map(([k, v]) => {
        selectClause.push(`${safeColumnName(k)} AS ${safeColumnName(v)}`)
      })
    } else {
      selectClause.push('*')
    }

    const sql: ISql = {
      $statement: [
        `SELECT ${selectClause.join(',')}`,
        `FROM ${this.name}`,
        where ? `WHERE ${where.$statement}` : '',
        ...postfix,
      ].join(' '),
      $params: where ? where.$params : {},
    }

    await this.emit('find-sql', sql)
    const r = (await this.sql.all(sql.$statement, sql.$params)).map((el) => this._loadData(el))

    return r
  }

  /**
   * Similar to `find`, but always limit to 1 item
   *
   * @param cond
   * @param fields
   */
  async get (
    cond: Record<string, any>,
    fields?: string[] | Record<string, string>,
  ): Promise<any | null> {
    return (await this.find(cond, fields, { limit: 1 }))[0] || null
  }

  /**
   *
   * @param cond
   * @param set
   * @param options
   */
  async update (
    cond: Record<string, any>,
    set: Partial<T>,
    options: {
      postfix?: string
      // limit?: number
    } = {},
  ) {
    const postfix = options.postfix ? [options.postfix] : []
    // if (options.limit) {
    //   postfix += ` LIMIT ${options.limit}`
    // }

    await this.emit('pre-update', { cond, set, options: { postfix } })

    const setK: string[] = []
    const setV: Record<string, any> = {}
    const where = _parseCond(cond, {
      [this.name]: this,
    })

    for (let [k, v] of Object.entries<any>(set)) {
      const prop = (this.__meta.prop as any)[k]
      if (prop) {
        const { type } = prop
        const tr = type ? (this.__meta.transform as any)[type] : undefined
        if (tr) {
          v = tr.set(v)
        }

        const id = `$${safeId()}`

        setK.push(`${k} = ${id}`)
        setV[id] = v
      }
    }

    const sql: ISql = {
      $statement: [
        `UPDATE ${safeColumnName(this.name)}`,
        `SET ${setK.map(safeColumnName).join(',')}`,
        `${where ? `WHERE ${where.$statement}` : ''}`,
        ...postfix,
      ].join(' '),
      $params: {
        ...setV,
        ...(where ? where.$params : {}),
      },
    }

    await this.emit('update-sql', sql)
    await this.sql.run(sql.$statement, sql.$params)
  }

  /**
   *
   * @param cond
   * @param options
   */
  async delete (
    cond: Record<string, any>,
    options: {
      postfix?: string
      // limit?: number
    } = {},
  ) {
    const postfix = options.postfix ? [options.postfix] : []
    // if (options.limit) {
    //   postfix += ` LIMIT ${options.limit}`
    // }

    await this.emit('pre-delete', { cond, options: { postfix } })

    const where = _parseCond(cond, {
      [this.name]: this,
    })

    const sql: ISql = {
      $statement: [
        `DELETE FROM ${safeColumnName(this.name)}`,
        `${where ? `WHERE ${where.$statement}` : ''}`,
        ...postfix,
      ].join(' '),
      $params: (where ? where.$params : {}),
    }

    await this.emit('delete-sql', sql)
    await this.sql.run(sql.$statement, sql.$params)
  }

  /**
   * Do joining
   *
   * ```ts
   * col1.chain().join(col2, 'colId')
   * ```
   *
   * @param select Limit fields before joining
   */
  chain (select?: Array<keyof T> | Record<keyof T, string>): Chain<T> {
    return new Chain(this, select)
  }

  /**
   * Normally, you wouldn't need to call this direcly, but it works by converting custom entry to native
   *
   * @param entry
   */
  transformEntry (entry: Partial<T>): Record<string, string | number | boolean | null> {
    const output: Record<string, string | number | boolean | null> = {}

    for (const [k, v] of Object.entries<any>(entry)) {
      const prop = (this.__meta.prop as any)[k]
      if (prop && prop.type) {
        const tr = (this.__meta.transform as any)[prop.type]
        if (tr) {
          output[k] = tr.set(v)
        }
      }

      if (output[k] === undefined) {
        output[k] = v
      }
    }

    return output
  }

  private _loadData (data: any): Partial<T> {
    for (const [k, v] of Object.entries(data)) {
      const prop = (this.__meta.prop as any)[k]
      if (prop && prop.type) {
        const tr = (this.__meta.transform as any)[prop.type]
        if (tr) {
          data[k] = tr.get(v)
        }
      }
    }

    return data
  }
}

class Chain<T> extends Emittery.Typed<{
  join: Chain<T>
  'pre-data': {
    cond: Record<string, any>
    options: {
      postfix: string
    }
  }
  data: ISql
}> {
  cols: Record<string, Collection<any>> = {}
  firstCol: Collection<T>

  select: Record<string, string> = {}
  from: string[] = []

  constructor (firstCol: Collection<T>, firstSelect?: Array<keyof T> | Record<keyof T, string>) {
    super()

    this.cols[firstCol.name] = firstCol
    this.firstCol = firstCol

    if (firstSelect) {
      if (Array.isArray(firstSelect)) {
        for (const l of firstSelect) {
          this.select[safeColumnName(`${firstCol.name}.${l}`)] = safeColumnName(`${firstCol.name}__${l}`)
        }
      } else {
        for (const [l, v] of Object.entries<string>(firstSelect)) {
          this.select[safeColumnName(`${firstCol.name}.${l}`)] = safeColumnName(v)
        }
      }
    }

    this.from.push(`FROM ${safeColumnName(firstCol.name)}`)
  }

  get sql () {
    return this.firstCol.sql
  }

  /**
   *
   * @param to
   * @param foreignField
   * @param localField
   * @param select
   * @param type
   */
  join<U> (
    to: Collection<U>,
    foreignField: string | [string, string],
    localField: keyof U | '_id' = '_id' as any,
    select?: Array<keyof U> | Record<keyof U, string> | null,
    type?: 'left' | 'inner',
  ): this {
    if (select) {
      if (Array.isArray(select)) {
        for (const l of select) {
          this.select[safeColumnName(`${to.name}.${l}`)] = safeColumnName(`${to.name}__${l}`)
        }
      } else {
        for (const [l, v] of Object.entries<string>(select)) {
          this.select[safeColumnName(`${to.name}.${l}`)] = v
        }
      }
    }

    if (Array.isArray(foreignField)) {
      foreignField = foreignField.join('__')
    }

    this.from.push(
      `${type || ''} JOIN ${safeColumnName(to.name)}`,
      `ON ${safeColumnName(foreignField)} = ${safeColumnName(to.name)}.${localField}`)
    this.cols[to.name] = to

    this.emit('join', this)

    return this
  }

  async data (
    cond: Record<string, any> = {},
    options: {
      postfix?: string
      sort?: {
        key: string
        desc?: boolean
      }
      offset?: number
      limit?: number
    } = {},
  ): Promise<Array<Record<string, Record<string, any>>>> {
    let postfix = options.postfix || ''
    if (options.sort) {
      postfix += ` ORDER BY ${safeColumnName(options.sort.key)} ${options.sort.desc ? 'DESC' : 'ASC'}`
    }
    if (options.limit) {
      postfix += ` LIMIT ${options.limit}`
    }
    if (options.offset) {
      postfix += ` OFFSET ${options.offset}`
    }

    await this.emit('pre-data', { cond, options: { postfix } })

    const where = _parseCond(cond, this.cols)

    const sql = {
      $statement: [
        `SELECT ${Object.entries(this.select).map(([k, v]) => `${safeColumnName(k)} AS ${safeColumnName(v)}`).join(',')}`,
        this.from.join('\n'),
        where ? `WHERE ${where.$statement}` : '',
        postfix,
      ].join(' '),
      $params: where ? where.$params : {},
    }

    await this.emit('data', sql)

    return (await this.sql.all(sql.$statement, sql.$params)).map((c) => {
      return this.transformRow(c)
    })
  }

  transformRow (row: any) {
    const item: Record<string, Record<string, any>> = {}

    for (const [k, v] of Object.entries<any>(row)) {
      const [tableName, r] = k.split('__')

      const prop = (this.cols[tableName].__meta.prop as any)[r]
      if (prop && prop.type) {
        const tr = (this.cols[tableName].__meta.transform as any)[prop.type]
        if (tr) {
          item[tableName] = item[tableName] || {}
          item[tableName][r] = tr.get(v)
        }
      }

      item[tableName] = item[tableName] || {}
      if (item[tableName][r] === undefined) {
        item[tableName][r] = v
      }
    }

    return item
  }
}

function _parseCond (q: Record<string, any>, cols: Record<string, Collection<any>>): ISql {
  if (q.$statement) {
    return {
      $statement: q.$statement,
      $params: q.$params || {},
    }
  }

  const subClause: string[] = []
  const $params: Record<string, any> = {}

  if (Array.isArray(q.$or)) {
    const c = q.$or.map((el) => {
      const r = _parseCond(el, cols)
      Object.assign($params, r.$params)

      return r.$statement
    }).join(' OR ')

    subClause.push(`(${c})`)
  } else if (Array.isArray(q.$and)) {
    const c = q.$and.map((el) => {
      const r = _parseCond(el, cols)
      Object.assign($params, r.$params)

      return r.$statement
    }).join(' AND ')

    subClause.push(`(${c})`)
  } else {
    const r = _parseCondBasic(q, cols)

    subClause.push(`(${r.$statement})`)
    Object.assign($params, r.$params)
  }

  return {
    $statement: subClause.join(' AND ') || 'TRUE',
    $params,
  }
}

function _parseCondBasic (cond: Record<string, any>, cols: Record<string, Collection<any>>): ISql {
  if (cond.$statement) {
    return {
      $statement: cond.$statement,
      $params: cond.$params || [],
    }
  }

  const cList: string[] = []
  const $params: Record<string, any> = {}

  function doDefault (k: string, v: any, id: string) {
    if (strArrayCols.includes(k)) {
      Object.assign($params, { [id]: v })
      cList.push(`${k} LIKE '%\x1f'||${id}||'\x1f%'`)
    } else {
      Object.assign($params, { [id]: v })
      cList.push(`${k} = ${id}`)
    }
  }

  const strArrayCols = Object.values(cols).map((c) => {
    const strArrayFields = Object.entries(c.__meta.prop)
      .filter(([_, v]) => v && v.type === 'StringArray')
      .map(([k]) => k)
    return [
      ...strArrayFields.map((f) => safeColumnName(f)),
      ...strArrayFields.map((f) => `${c.name}__${f}`),
    ]
  }).reduce((prev, c) => [...prev, ...c], [])

  for (let [k, v] of Object.entries(cond)) {
    let isPushed = false
    if (k.includes('.')) {
      const kn = k.split('.')
      k = `json_extract(${safeColumnName(kn[0])}, '$.${safeColumnName(kn.slice(1).join('.'))}')`
    } else {
      k = safeColumnName(k)
    }
    const isStrArray = strArrayCols.includes(k)

    if (v instanceof Date) {
      v = +v
    }

    const id = `$${safeId()}`

    if (v) {
      if (Array.isArray(v)) {
        if (isStrArray) {
          cList.push(`(${(v.map((v0) => {
            const id = `$${safeId()}`
            Object.assign($params, { [id]: v0 })
            return `${k} LIKE '%\x1f'||${id}||'\x1f%'`
          })).join(' AND ')})`)
        } else {
          if (v.length > 1) {
            const vObj = v.reduce((prev, c) => ({ ...prev, [`$${safeId()}`]: c }), {})
            cList.push(`${k} IN (${Object.keys(vObj).join(',')})`)
            Object.assign($params, vObj)
          } else if (v.length === 1) {
            const id = `$${safeId()}`
            cList.push(`${k} = ${id}`)
            Object.assign($params, { [id]: v[0] })
          }
        }
      } else if (typeof v === 'object' && v.toString() === '[object Object]') {
        const op = Object.keys(v)[0]
        let v1 = v[op]
        if (v1 instanceof Date) {
          v1 = +v1
        }

        if (Array.isArray(v1)) {
          switch (op) {
            case '$in':
              if (isStrArray) {
                cList.push(`(${(v1.map((v0) => {
                  const id = `$${safeId()}`
                  Object.assign($params, { [id]: v0 })
                  return `${k} LIKE '%\x1f'||${id}||'\x1f%'`
                })).join(' OR ')})`)
              } else {
                if (v1.length > 1) {
                  const vObj = v1.reduce((prev, c) => ({ ...prev, [`$${safeId()}`]: c }), {})
                  cList.push(`${k} IN (${Object.keys(vObj).join(',')})`)
                  Object.assign($params, vObj)
                } else if (v1.length === 1) {
                  const id = `$${safeId()}`
                  cList.push(`${k} = ${id}`)
                  Object.assign($params, { [id]: v1[0] })
                }
              }
              isPushed = true
              break
            case '$nin':
              if (v1.length > 1) {
                const vObj = v1.reduce((prev, c) => ({ ...prev, [`$${safeId()}`]: c }), {})
                cList.push(`${k} NOT IN (${Object.keys(vObj).join(',')})`)
                Object.assign($params, vObj)
              } else {
                const id = `$${safeId()}`
                cList.push(`${k} != ${id}`)
                Object.assign($params, { [id]: v1[0] })
              }
              isPushed = true
              break
          }
        }

        if (isPushed) {
          continue
        }

        if (v1 && typeof v1 === 'object') {
          if (v1 instanceof Date) {
            k = `json_extract(${k}, '$.$milli')`
            v1 = +v1
          } else {
            v1 = JSON.stringify(v1)
          }
        }

        switch (op) {
          case '$like':
            cList.push(`${k} LIKE ${id}`)
            Object.assign($params, { [id]: v1 })
            break
          case '$nlike':
            cList.push(`${k} NOT LIKE ${id}`)
            Object.assign($params, { [id]: v1 })
            break
          case '$substr':
            cList.push(`${k} LIKE '%'||${id}||'%'`)
            Object.assign($params, { [id]: v1 })
            break
          case '$nsubstr':
            cList.push(`${k} NOT LIKE '%'||${id}||'%'`)
            Object.assign($params, { [id]: v1 })
            break
          case '$exists':
            cList.push(`${k} IS ${v1 ? 'NOT NULL' : 'NULL'}`)
            break
          case '$gt':
            cList.push(`${k} > ${id}`)
            Object.assign($params, { [id]: v1 })
            break
          case '$gte':
            cList.push(`${k} >= ${id}`)
            Object.assign($params, { [id]: v1 })
            break
          case '$lt':
            cList.push(`${k} < ${id}`)
            Object.assign($params, { [id]: v1 })
            break
          case '$lte':
            cList.push(`${k} <= ${id}`)
            Object.assign($params, { [id]: v1 })
            break
          case '$ne':
            cList.push(`${k} != ${id}`)
            Object.assign($params, { [id]: v1 })
            break
          default:
            doDefault(k, v, id)
        }
      } else {
        doDefault(k, v, id)
      }
    } else {
      doDefault(k, v, id)
    }
  }

  return {
    $statement: cList.join(' AND ') || 'TRUE',
    $params,
  }
}
