# typed: false
# frozen_string_literal: true

class Postgresai < Formula
  desc "postgres_ai CLI (Node.js)"
  homepage "https://gitlab.com/postgres-ai/postgres_ai"
  url "https://registry.npmjs.org/postgresai/-/postgresai-0.14.0-beta.12.tgz"
  sha256 "7630c76cacd821c994407133e1ee6d90bc467772e32a4cf110d5a74480a16edc"
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/postgres-ai --version")
    assert_match "PostgresAI CLI", shell_output("#{bin}/postgres-ai --help")
    assert_match version.to_s, shell_output("#{bin}/pgai --version")
  end
end

