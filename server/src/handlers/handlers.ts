/*
 * Copyright 2020 Thomas Plougsgaard
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { InitializeParams, InitializeResult, InlayHintParams, ServerRequestHandler, TextDocumentSyncKind } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'

import * as jobs from '../engine/jobs'
import * as queue from '../engine/queue'
import * as engine from '../engine'
import * as socket from '../engine/socket'

import { clearDiagnostics, sendDiagnostics, sendNotification } from '../server'
import { makePositionalHandler, makeEnqueuePromise, enqueueUnlessHasErrors, makeDefaultResponseHandler } from './util'
import { getProjectRootUri } from '../engine'

const _ = require('lodash/fp')

interface UriInput {
  uri: string
}

function printHorizontalRuler () {
  console.log(_.repeat(48, String.fromCodePoint(0x23E4)))
}

export function handleInitialize (_params: InitializeParams) {
  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentHighlightProvider: true,
      completionProvider: {
          
      }, 
      hoverProvider: true,
      inlayHintProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      codeLensProvider: {
        resolveProvider: true
      },
      renameProvider: {
        prepareProvider: false
      },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      implementationProvider: true,
      semanticTokensProvider: {
        // NB: Must be in sync with ca.uwaterloo.flix.api.lsp.SemanticTokenType.
        legend: {
          tokenTypes: [
              "class",
              "enum",
              "enumMember",
              "function",
              "interface",
              "operator",
              "parameter",
              "property",
              "method",
              "namespace",
              "type",
              "typeParameter",
              "variable"
            ],
          tokenModifiers: ["declaration"]
        },
        full: true
      }
    }
  }
  return result
}

export function handleReplaceConfiguration (userConfiguration: engine.UserConfiguration) {
  engine.updateUserConfiguration(userConfiguration)
}

/**
 * Runs when both client and server are ready.
 */
export function handleReady (engineInput: engine.StartEngineInput) {
  engine.start(engineInput)
}

export function handleAddUri ({ uri }: UriInput) {
  engine.addUri(uri)
}

export function handleRemUri ({ uri }: UriInput) {
  engine.remUri(uri)
}

export function handleAddPkg ( { uri } : UriInput) {
  engine.addPkg(uri)
}

export function handleRemPkg ({ uri }: UriInput) {
  engine.remPkg(uri)
}

export function handleAddJar ( { uri } : UriInput) {
  engine.addJar(uri)
}

export function handleRemJar ({ uri }: UriInput) {
  engine.remJar(uri)
}

export function handleExit () {
  engine.stop()
}

export function handleSave (params: any) {
  if (engine.compileOnSaveEnabled()) {
    addUriToCompiler(params.document, true)
  }
}

export function handleChangeContent (params: any) {
  if (engine.compileOnChangeEnabled()) {
    // We send the document immediately to ensure better auto-complete.
    addUriToCompiler(params.document, true)
  }
}

function addUriToCompiler (document: TextDocument, skipDelay?: boolean) {
  const job: jobs.Job = {
    request: jobs.Request.apiAddUri,
    uri: document.uri, // Note: this typically has the file:// scheme (important for files as keys)
    src: document.getText()
  }
  queue.enqueue(job, skipDelay)
}

/**
 * @function
 */
export const handleGotoDefinition = makePositionalHandler(jobs.Request.lspGoto, undefined, makeGotoDefinitionResponseHandler)

function makeGotoDefinitionResponseHandler (promiseResolver: Function) {
  return function responseHandler ({ status, result }: socket.FlixResponse) {
    const targetUri = _.get('targetUri', result)
    if (status === 'success') {
      if (_.startsWith('file://', targetUri)) {
        return promiseResolver(result)
      } else {
        sendNotification(jobs.Request.internalMessage, `Source for: '${targetUri}' is unavailable.`)
      }
    }
    promiseResolver()
  }
}

/**
 * @function
 */
export const handleImplementation = makePositionalHandler(jobs.Request.lspImplementation);

/**
 * @function
 */
export const handleHighlight = makePositionalHandler(jobs.Request.lspHighlight)

/**
 * @function
 */
 export const handleComplete = makePositionalHandler(jobs.Request.lspComplete)


/**
 * @function
 */
export const handleHover = makePositionalHandler(jobs.Request.lspHover)

/**
 * @function
 */
export const handleReferences = makePositionalHandler(jobs.Request.lspUses)

/**
 * @function
 */
export const handleCodelens = makePositionalHandler(jobs.Request.lspCodelens)

/**
 * @function
 */
export const handleRename = enqueueUnlessHasErrors(makeRenameJob, makeDefaultResponseHandler, hasErrorsHandlerForCommands)

function makeRenameJob (params: any) {
  return {
    request: jobs.Request.lspRename,
    uri: params.textDocument.uri,
    position: params.position,
    newName: params.newName
  }
}

/**
 * @function 
 */
export const handleDocumentSymbols = makePositionalHandler(jobs.Request.lspDocumentSymbols);

/**
 * @function
 */
export const handleWorkspaceSymbols = enqueueUnlessHasErrors(makeWorkspaceSymbolsJob, makeDefaultResponseHandler, hasErrorsHandlerForCommands)

function makeWorkspaceSymbolsJob(params: any) {
    return {
        request: jobs.Request.lspWorkspaceSymbols,
        position: params.position,
        query: params.query || ''
    }
}

/**
 * @function
 */
export const handleSemanticTokens = makePositionalHandler(jobs.Request.lspSemanticTokens)

export const handleInlayHints = (params: InlayHintParams): Thenable<any> => new Promise((resolve) => {
  const job = engine.enqueueJobWithFlattenedParams(jobs.Request.lspInlayHints, { uri: params.textDocument.uri, range: params.range });
  socket.eventEmitter.once(job.id, makeDefaultResponseHandler(resolve));
});

/**
 * @function
 */
export const handleRunTests = enqueueUnlessHasErrors({ request: jobs.Request.cmdRunTests }, makeRunTestsResponseHandler, hasErrorsHandlerForCommands)

function prettyPrintTestResults (result: any) {
  if (_.isEmpty(result)) {
    // nothing to print
    sendNotification(jobs.Request.internalMessage, 'No tests to run')
    return
  }
  printHorizontalRuler()
  for (const test of result) {
    console.log(
      test.outcome === 'success' 
        ? String.fromCodePoint(0x2705) 
        : String.fromCodePoint(0x274C),
      test.name,
      test.outcome === 'success' 
        ? '' 
        : `(at ${test.location.uri}#${test.location.range.start.line}:${test.location.range.start.character})`
    )
  }
  printHorizontalRuler()
  const totalTests = _.size(result)
  const successfulTests = _.size(_.filter({ outcome: 'success' }, result))
  const failingTests = totalTests - successfulTests
  if (failingTests > 0) {
    sendNotification(jobs.Request.internalError, `Tests Failed (${failingTests}/${totalTests})`)
  } else {
    sendNotification(jobs.Request.internalMessage, `Tests Passed (${successfulTests}/${totalTests})`)
  }
}

function makeRunTestsResponseHandler (promiseResolver: Function) {
  return function responseHandler (flixResponse: socket.FlixResponse) {
    // the status is always 'success' when with failing tests
    const { result } = flixResponse
    prettyPrintTestResults(result)
    promiseResolver(result)
    sendNotification(jobs.Request.internalFinishedJob, flixResponse)
  }
}

function hasErrorsHandlerForCommands () {
  sendNotification(jobs.Request.internalError, 'Cannot run commands when errors are present.')
  sendNotification(jobs.Request.internalFinishedJob)
}

/**
 * @function
 */
export const handleVersion = makeEnqueuePromise(jobs.Request.apiVersion, makeVersionResponseHandler)

function makeVersionResponseHandler (promiseResolver: Function) {
  return function responseHandler ({ status, result }: any) {
    // version is called on startup currently
    // use this to communicate back to the client that startup is done
    sendNotification(jobs.Request.internalReady)
    if (status === 'success') {
      const { major, minor, revision } = result
      const message = `Flix ${major}.${minor}.${revision} Ready! (Extension: ${engine.getExtensionVersion()}) (Using ${engine.getFlixFilename()})`
      sendNotification(jobs.Request.internalMessage, message)
    } else {
      sendNotification(jobs.Request.internalError, 'Failed starting Flix')
    }
    promiseResolver()
  }
}

/**
 * Handle response from lsp/check
 *
 * This is different from the rest of the response handlers in that it isn't tied together with its enqueueing function.
 */
export function lspCheckResponseHandler ({ status, result }: socket.FlixResponse) {
  clearDiagnostics()
  sendNotification(jobs.Request.internalDiagnostics, { status, result })
  if (status !== 'success') {
    _.each(sendDiagnostics, result)
  }
}
