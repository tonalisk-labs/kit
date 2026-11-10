// Evaluates TLS server certificates as macOS does, with one CA as the only anchor. Its arguments
// are the CA's PEM, then pairs of a leaf's PEM and the host it is asked for; it prints a line per
// pair, `<host>: trusted` or `<host>:` and the checks the chain failed.
import Foundation
import Security

func certificate(at path: String) -> SecCertificate {
    let pem = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
    let base64 = pem.split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()
    guard let der = Data(base64Encoded: base64),
        let certificate = SecCertificateCreateWithData(nil, der as CFData)
    else {
        fatalError("\(path) holds no PEM certificate")
    }
    return certificate
}

/// The result's details are undocumented: one dictionary per certificate, keyed by each check it
/// failed, beside the status codes.
func failedChecks(of trust: SecTrust) -> [String] {
    let result = SecTrustCopyResult(trust) as? [String: Any]
    let details = result?["TrustResultDetails"] as? [[String: Any]] ?? []
    return details.flatMap { $0.keys.filter { $0 != "StatusCodes" } }.sorted()
}

func evaluation(of leaf: SecCertificate, for host: String, anchor: SecCertificate) -> String {
    let policy = SecPolicyCreateSSL(true, host as CFString)
    var made: SecTrust?
    let status = SecTrustCreateWithCertificates(leaf, policy, &made)
    guard status == errSecSuccess, let trust = made else {
        fatalError("no trust for \(host): \(status)")
    }
    SecTrustSetAnchorCertificates(trust, [anchor] as CFArray)
    SecTrustSetAnchorCertificatesOnly(trust, true)
    if SecTrustEvaluateWithError(trust, nil) {
        return "\(host): trusted"
    }
    return "\(host): \(failedChecks(of: trust).joined(separator: ", "))"
}

let arguments = Array(CommandLine.arguments.dropFirst())
let anchor = certificate(at: arguments[0])
for index in stride(from: 1, to: arguments.count - 1, by: 2) {
    let leaf = certificate(at: arguments[index])
    print(evaluation(of: leaf, for: arguments[index + 1], anchor: anchor))
}
