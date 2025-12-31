# typed: false
# frozen_string_literal: true

class Postgresai < Formula
  desc "postgres_ai CLI (Node.js)"
  homepage "https://gitlab.com/postgres-ai/postgres_ai"
  url "https://registry.npmjs.org/postgresai/-/postgresai-0.14.0-beta.3.tgz"
  sha256 "8de506a7384578b95aa6bfb4e0142c483298478e1b7d6d49c9ed5b2e9bb935c9"
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

