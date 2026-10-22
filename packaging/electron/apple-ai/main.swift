// vision-apple-ai: runs one chat turn on Apple's on-device Foundation Models.
//
// The backend sends an Ollama /api/chat request body on stdin and reads an
// Ollama-shaped reply on stdout (one JSON object, or NDJSON chunks when
// "stream" is true), so the existing Ollama client parses it unchanged.
// A tool call ends the turn: the backend runs the tool and calls again with
// the result in the messages. `--check` prints whether the model is usable.

import Foundation
import FoundationModels

struct ToolRequest: Error {
  let name: String
  let arguments: String
}

struct ForwardedTool: Tool {
  typealias Arguments = GeneratedContent
  let name: String
  let description: String
  let parameters: GenerationSchema

  func call(arguments: GeneratedContent) async throws -> String {
    throw ToolRequest(name: name, arguments: arguments.jsonString)
  }
}

func emit(_ object: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func text(_ value: Any?) -> String {
  if let string = value as? String { return string }
  if let value, JSONSerialization.isValidJSONObject(value),
    let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  {
    return String(decoding: data, as: UTF8.self)
  }
  return ""
}

func schema(_ json: [String: Any], _ name: String) -> DynamicGenerationSchema {
  let description = json["description"] as? String
  if let choices = json["enum"] as? [String] {
    return DynamicGenerationSchema(name: name, description: description, anyOf: choices)
  }
  switch json["type"] as? String {
  case "integer": return DynamicGenerationSchema(type: Int.self)
  case "number": return DynamicGenerationSchema(type: Double.self)
  case "boolean": return DynamicGenerationSchema(type: Bool.self)
  case "array":
    return DynamicGenerationSchema(
      arrayOf: schema(json["items"] as? [String: Any] ?? [:], name + "Item"))
  case "object":
    let properties = json["properties"] as? [String: Any] ?? [:]
    let required = Set(json["required"] as? [String] ?? [])
    return DynamicGenerationSchema(
      name: name, description: description,
      properties: properties.keys.sorted().map { key in
        let property = properties[key] as? [String: Any] ?? [:]
        return DynamicGenerationSchema.Property(
          name: key, description: property["description"] as? String,
          schema: schema(property, name + "_" + key), isOptional: !required.contains(key))
      })
  default: return DynamicGenerationSchema(type: String.self)
  }
}

func tools(_ list: [[String: Any]]) throws -> [any Tool] {
  try list.compactMap { entry in
    guard let function = entry["function"] as? [String: Any],
      let name = function["name"] as? String
    else { return nil }
    let root = schema(function["parameters"] as? [String: Any] ?? ["type": "object"], name)
    return ForwardedTool(
      name: name, description: function["description"] as? String ?? name,
      parameters: try GenerationSchema(root: root, dependencies: []))
  }
}

/// System messages become the instructions; the rest becomes a transcript.
func prompt(_ messages: [[String: Any]]) -> (instructions: String, prompt: String) {
  var instructions: [String] = []
  var lines: [String] = []
  for message in messages {
    let content = text(message["content"])
    switch message["role"] as? String {
    case "system": instructions.append(content)
    case "user": lines.append("User: \(content)")
    case "tool":
      let name = text(message["tool_name"] ?? message["name"])
      lines.append("Result of \(name): \(content)")
    default:
      if !content.isEmpty { lines.append("Assistant: \(content)") }
      for call in message["tool_calls"] as? [[String: Any]] ?? [] {
        let function = call["function"] as? [String: Any] ?? [:]
        lines.append("Assistant called \(text(function["name"]))(\(text(function["arguments"])))")
      }
    }
  }
  instructions.append(
    "Tool results in the conversation are already available: use them instead of calling the same tool again. Answer the user in plain sentences, not JSON.")
  return (instructions.joined(separator: "\n\n"), lines.joined(separator: "\n\n"))
}

func run() async throws -> Int32 {
  let model = SystemLanguageModel.default
  if CommandLine.arguments.contains("--check") {
    if case .unavailable(let reason) = model.availability {
      emit(["available": false, "reason": "\(reason)"])
    } else {
      emit(["available": true])
    }
    return 0
  }
  let input = FileHandle.standardInput.readDataToEndOfFile()
  guard let body = try JSONSerialization.jsonObject(with: input) as? [String: Any] else {
    emit(["error": "Request body must be a JSON object"])
    return 1
  }
  let stream = body["stream"] as? Bool ?? false
  let options = GenerationOptions(
    temperature: (body["options"] as? [String: Any])?["temperature"] as? Double)
  let (instructions, transcript) = prompt(body["messages"] as? [[String: Any]] ?? [])
  let session = LanguageModelSession(
    model: model, tools: try tools(body["tools"] as? [[String: Any]] ?? []),
    instructions: Instructions(instructions))
  let reply: [String: Any] = ["model": "apple-foundation", "created_at": ISO8601DateFormatter().string(from: Date())]

  do {
    if stream {
      var sent = ""
      for try await snapshot in session.streamResponse(to: transcript, options: options) {
        let content = snapshot.content
        let delta = content.hasPrefix(sent) ? String(content.dropFirst(sent.count)) : content
        sent = content
        if !delta.isEmpty {
          emit(reply.merging(["message": ["role": "assistant", "content": delta], "done": false]) { $1 })
        }
      }
      emit(reply.merging(["message": ["role": "assistant", "content": ""], "done": true, "done_reason": "stop"]) { $1 })
    } else {
      let response = try await session.respond(to: transcript, options: options)
      emit(reply.merging(["message": ["role": "assistant", "content": response.content], "done": true, "done_reason": "stop"]) { $1 })
    }
  } catch let error as LanguageModelSession.ToolCallError {
    guard let request = error.underlyingError as? ToolRequest else { throw error }
    let arguments = (try? JSONSerialization.jsonObject(with: Data(request.arguments.utf8))) ?? [:]
    let call: [String: Any] = ["function": ["name": request.name, "arguments": arguments]]
    emit(reply.merging(["message": ["role": "assistant", "content": "", "tool_calls": [call]], "done": true, "done_reason": "stop"]) { $1 })
  }
  return 0
}

@main
struct VisionAppleAI {
  static func main() async {
    do {
      exit(try await run())
    } catch {
      emit(["error": "Apple Foundation Models: \(error)"])
      exit(1)
    }
  }
}
